"""BioQuest training worker.

Polls the `training_jobs` table, decrypts verified + consented photos in memory
(never writing plaintext images to disk), fine-tunes an image classifier, exports
it to ONNX and registers it in `models`. The researcher then activates it from
the dashboard and the web app starts using it for suggestions.

Runs as the least-privilege Postgres role `bioquest_worker`: it can read only
verified, research-consented media (enforced by Row-Level Security) and cannot
see users, emails or sessions.
"""
import hashlib, io, json, os, random, sys, time, traceback, uuid
from pathlib import Path

import psycopg2, psycopg2.extras
import torch, torch.nn as nn
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from PIL import Image
from torch.utils.data import DataLoader, Dataset
from torchvision import models, transforms


def load_env():
    p = Path(__file__).resolve().parent.parent / ".env"
    if p.exists():
        for line in p.read_text().splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip("\"'"))


load_env()
DB = os.environ["WORKER_DATABASE_URL"]
UPLOAD_DIR = Path(os.environ.get("UPLOAD_DIR", "./storage/vault")).resolve()
MODEL_DIR = Path(os.environ.get("MODEL_DIR", "./storage/models")).resolve()
KEKS = {int(k.rsplit("_", 1)[1]): bytes.fromhex(v) for k, v in os.environ.items() if k.startswith("MEDIA_KEK_")}
MEAN, STD = [0.485, 0.456, 0.406], [0.229, 0.224, 0.225]
log_lines = []


def unwrap_dek(wrapped: bytes, version: int) -> bytes:
    iv, tag, ct = wrapped[:12], wrapped[12:28], wrapped[28:]
    return AESGCM(KEKS[version]).decrypt(iv, ct + tag, f"dek:v{version}".encode())


def read_image(row) -> Image.Image:
    key = row["storage_key"]
    blob = (UPLOAD_DIR / key[:2] / key[2:4] / f"{key}.bin").read_bytes()
    dek = unwrap_dek(bytes(row["dek_wrapped"]), row["kek_version"])
    plain = AESGCM(dek).decrypt(bytes(row["iv"]), blob + bytes(row["auth_tag"]), None)
    return Image.open(io.BytesIO(plain)).convert("RGB")


class DS(Dataset):
    def __init__(self, items, size, train):
        self.items = items
        norm = transforms.Normalize(MEAN, STD)
        if train:
            self.tf = transforms.Compose([transforms.RandomResizedCrop(size, scale=(0.6, 1.0)), transforms.RandomHorizontalFlip(),
                                          transforms.ColorJitter(0.2, 0.2, 0.2), transforms.ToTensor(), norm])
        else:
            self.tf = transforms.Compose([transforms.Resize((size, size)), transforms.ToTensor(), norm])

    def __len__(self): return len(self.items)

    def __getitem__(self, i):
        img, y = self.items[i]
        return self.tf(img), y


def build(arch, n, pretrained):
    def w(cls):
        if not pretrained: return None
        try: return cls.DEFAULT
        except Exception: return None
    try:
        if arch == "mobilenet_v3_small":
            m = models.mobilenet_v3_small(weights=w(models.MobileNet_V3_Small_Weights)); m.classifier[3] = nn.Linear(m.classifier[3].in_features, n)
        elif arch == "efficientnet_b0":
            m = models.efficientnet_b0(weights=w(models.EfficientNet_B0_Weights)); m.classifier[1] = nn.Linear(m.classifier[1].in_features, n)
        else:
            m = models.resnet18(weights=w(models.ResNet18_Weights)); m.fc = nn.Linear(m.fc.in_features, n)
    except Exception as e:  # offline: fall back to random init rather than failing the job
        log(f"Could not download pretrained weights ({e}); training from scratch.")
        return build(arch, n, False)
    return m


def log(msg):
    print(msg, flush=True)
    log_lines.append(msg)


def run_job(conn, job):
    p, jid = job["params"], job["id"]
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    def update(**kw):
        sets = ", ".join(f"{k} = %s" for k in kw)
        cur.execute(f"UPDATE training_jobs SET {sets} WHERE id = %s", [*kw.values(), jid]); conn.commit()

    def cancelled():
        cur.execute("SELECT status FROM training_jobs WHERE id = %s", (jid,)); r = cur.fetchone(); conn.commit()
        return r["status"] == "cancelled"

    cur.execute("""SELECT m.storage_key, m.dek_wrapped, m.kek_version, m.iv, m.auth_tag, s.slug
                     FROM media m JOIN observations o ON o.id = m.observation_id JOIN species s ON s.id = o.species_id
                    WHERE m.kind = 'image' AND o.status = 'verified' AND o.consent_research""")
    rows = cur.fetchall(); conn.commit()
    counts = {}
    for r in rows: counts[r["slug"]] = counts.get(r["slug"], 0) + 1
    labels = sorted(s for s, c in counts.items() if c >= p["minPerClass"])
    if len(labels) < 2: raise RuntimeError(f"Only {len(labels)} species have {p['minPerClass']}+ verified photos.")
    log(f"Dataset: {len(labels)} species, {sum(counts[s] for s in labels)} images")

    size = p["imageSize"]; items = []
    for r in rows:
        if r["slug"] in labels:
            items.append((read_image(r).resize((size + 32, size + 32)), labels.index(r["slug"])))
    random.seed(42); random.shuffle(items)
    nval = max(len(labels), int(len(items) * p["valSplit"]))
    val, train = items[:nval], items[nval:]
    log(f"Train {len(train)} / validation {len(val)}")

    dev = "cuda" if torch.cuda.is_available() else "cpu"
    model = build(p["arch"], len(labels), p["pretrained"]).to(dev)
    tl = DataLoader(DS(train, size, True), batch_size=32, shuffle=True)
    vl = DataLoader(DS(val, size, False), batch_size=64)
    opt = torch.optim.AdamW(model.parameters(), lr=p["learningRate"], weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=p["epochs"])
    lossf = nn.CrossEntropyLoss(label_smoothing=0.05)

    best = {"acc": -1, "state": None}
    for ep in range(p["epochs"]):
        if cancelled(): raise InterruptedError("cancelled")
        model.train()
        for x, y in tl:
            x, y = x.to(dev), y.to(dev); opt.zero_grad(); lossf(model(x), y).backward(); opt.step()
        sched.step()
        model.eval(); ok = 0
        with torch.no_grad():
            for x, y in vl: ok += (model(x.to(dev)).argmax(1).cpu() == y).sum().item()
        acc = ok / len(val)
        if acc > best["acc"]: best = {"acc": acc, "state": {k: v.cpu().clone() for k, v in model.state_dict().items()}}
        log(f"epoch {ep + 1}/{p['epochs']}  val_acc={acc:.3f}")
        update(progress=(ep + 1) / p["epochs"], log_tail="\n".join(log_lines[-40:]))

    model.load_state_dict(best["state"]); model.eval(); model.to("cpu")
    top3 = 0; tp = [0] * len(labels); sup = [0] * len(labels); pred_n = [0] * len(labels)
    with torch.no_grad():
        for x, y in vl:
            out = model(x); pr = out.argmax(1)
            top3 += sum(int(t in o.topk(min(3, len(labels))).indices) for o, t in zip(out, y))
            for a, b in zip(pr.tolist(), y.tolist()):
                sup[b] += 1; pred_n[a] += 1; tp[b] += int(a == b)
    metrics = {"val_accuracy": best["acc"], "top3_accuracy": top3 / len(val), "image_size": size, "train_images": len(train), "val_images": len(val),
               "per_class": {l: {"recall": tp[i] / sup[i] if sup[i] else None, "precision": tp[i] / pred_n[i] if pred_n[i] else None, "support": sup[i]} for i, l in enumerate(labels)}}

    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    path = MODEL_DIR / f"model-{uuid.uuid4().hex}.onnx"
    torch.onnx.export(model, torch.randn(1, 3, size, size), str(path), input_names=["input"], output_names=["logits"],
                      dynamic_axes={"input": {0: "batch"}}, opset_version=17)
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    cur.execute("""INSERT INTO models (arch, onnx_path, labels, metrics, sha256, created_by)
                   VALUES (%s,%s,%s,%s,%s,(SELECT requested_by FROM training_jobs WHERE id=%s)) RETURNING id""",
                (p["arch"], path.name, json.dumps(labels), json.dumps(metrics), digest, jid))
    mid = cur.fetchone()["id"]
    update(status="succeeded", progress=1, metrics=json.dumps(metrics), model_id=mid, finished_at=time.strftime("%Y-%m-%d %H:%M:%S%z"),
           log_tail="\n".join(log_lines[-40:] + [f"Saved model {path.name}"]))
    log(f"Done. val_acc={best['acc']:.3f}")


def main():
    log("BioQuest worker started. Waiting for jobs…")
    conn = psycopg2.connect(DB); conn.autocommit = False
    while True:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute("""UPDATE training_jobs SET status='running', started_at=now() WHERE id = (
                         SELECT id FROM training_jobs WHERE status='queued' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
                       RETURNING id, params""")
        job = cur.fetchone(); conn.commit()
        if not job:
            time.sleep(5); continue
        log_lines.clear()
        try:
            run_job(conn, job)
        except InterruptedError:
            log("Cancelled by researcher.")
        except Exception as e:
            conn.rollback(); traceback.print_exc()
            c = conn.cursor(); c.execute("UPDATE training_jobs SET status='failed', finished_at=now(), log_tail=%s WHERE id=%s",
                                         ("\n".join(log_lines[-30:] + [f"ERROR: {e}"]), job["id"])); conn.commit()


if __name__ == "__main__":
    try: main()
    except KeyboardInterrupt: sys.exit(0)
