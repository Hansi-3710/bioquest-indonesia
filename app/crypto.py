"""All cryptography lives here.

One 32-byte MASTER_KEY is expanded with HKDF into independent sub-keys, so a leak of
one purpose (e.g. the IP-hash key) never exposes another.

* seal/open     AES-256-GCM for database fields (email, location, notes, 2FA secret).
                The row's public id is bound in as AAD, so ciphertext cannot be
                copied between rows or columns.
* encrypt_file  Envelope encryption for uploads: a random key per file encrypts the
                bytes; that key is itself wrapped with the master-derived key.
* blind         HMAC "blind index" so we can look up an email without storing it in clear.
"""
import base64
import hashlib
import hmac
import os

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

PURPOSES = ("field", "wrap", "bidx", "pepper", "audit", "ip")


def new_key():
    return base64.urlsafe_b64encode(os.urandom(32)).decode()


class Vault:
    def __init__(self, master_b64):
        master = base64.urlsafe_b64decode(master_b64.encode())
        if len(master) != 32:
            raise ValueError("MASTER_KEY must be 32 random bytes, urlsafe-base64 encoded.")
        self._keys = {
            p: HKDF(algorithm=hashes.SHA256(), length=32, salt=None,
                    info=b"bioquest-v1:" + p.encode()).derive(master)
            for p in PURPOSES
        }

    # -- authenticated encryption -------------------------------------------------
    def seal(self, plaintext: bytes, aad: bytes, purpose="field") -> bytes:
        nonce = os.urandom(12)
        return nonce + AESGCM(self._keys[purpose]).encrypt(nonce, plaintext, aad)

    def open(self, blob: bytes, aad: bytes, purpose="field") -> bytes:
        return AESGCM(self._keys[purpose]).decrypt(blob[:12], blob[12:], aad)

    # -- uploads ------------------------------------------------------------------
    def encrypt_file(self, data: bytes, file_id: str):
        dek = AESGCM.generate_key(bit_length=256)
        nonce = os.urandom(12)
        blob = nonce + AESGCM(dek).encrypt(nonce, data, file_id.encode())
        return blob, self.seal(dek, file_id.encode(), "wrap")

    def decrypt_file(self, blob: bytes, wrapped_dek: bytes, file_id: str) -> bytes:
        dek = self.open(wrapped_dek, file_id.encode(), "wrap")
        return AESGCM(dek).decrypt(blob[:12], blob[12:], file_id.encode())

    # -- keyed hashes ---------------------------------------------------------------
    def _mac(self, purpose, text: str) -> str:
        return hmac.new(self._keys[purpose], text.encode(), hashlib.sha256).hexdigest()

    def blind(self, text):      return self._mac("bidx", text)
    def pepper(self, password): return self._mac("pepper", password)
    def ip_hash(self, ip):      return self._mac("ip", ip)[:24]
    def audit_mac(self, text):  return self._mac("audit", text)
