"""Upload validation. We never trust the file name, the client MIME type or the extension."""
import io

from PIL import Image, ImageOps, UnidentifiedImageError

Image.MAX_IMAGE_PIXELS = 40_000_000  # decompression-bomb guard


class UploadError(ValueError):
    pass


def sniff(data: bytes):
    if data[:3] == b"\xff\xd8\xff" or data[:8] == b"\x89PNG\r\n\x1a\n" or (data[:4] == b"RIFF" and data[8:12] == b"WEBP"):
        return "image"
    if data[4:8] == b"ftyp" or data[:4] == b"\x1a\x45\xdf\xa3":
        return "video"
    return None


def clean_image(data: bytes) -> bytes:
    """Re-encode as JPEG: proves it really is an image and strips EXIF/GPS and any appended payload."""
    try:
        img = Image.open(io.BytesIO(data))
        img.load()
        img = ImageOps.exif_transpose(img).convert("RGB")
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as exc:
        raise UploadError("That image could not be read.") from exc
    img.thumbnail((2560, 2560))
    out = io.BytesIO()
    img.save(out, "JPEG", quality=88, optimize=True)
    return out.getvalue()


def prepare(data: bytes, max_image: int, max_video: int):
    """Returns (kind, mime, bytes_to_store)."""
    kind = sniff(data)
    if kind == "image":
        if len(data) > max_image:
            raise UploadError("Photos can be at most %d MB." % (max_image // 2**20))
        return "image", "image/jpeg", clean_image(data)
    if kind == "video":
        if len(data) > max_video:
            raise UploadError("Videos can be at most %d MB." % (max_video // 2**20))
        return "video", ("video/webm" if data[:4] == b"\x1a\x45\xdf\xa3" else "video/mp4"), data
    raise UploadError("Only JPEG, PNG, WebP photos and MP4/WebM videos are accepted.")
