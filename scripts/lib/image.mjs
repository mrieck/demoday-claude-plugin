/**
 * Image dimension + aspect-ratio helpers.
 * Ported from the actor's src/mcp-server/fal/utils.ts (getImageDimensions,
 * veo aspect helpers, calculateExpandCanvas) so gen-video and expand-image agree.
 */

/** Parse width/height from a PNG/JPEG/WEBP buffer without decoding it. */
export function dimensionsFromBuffer(buffer) {
  // PNG: signature 89 50 4E 47, IHDR width@16 height@20 (big-endian)
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  // JPEG: scan for a SOF marker
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset < buffer.length - 9) {
      if (buffer[offset] === 0xff) {
        const marker = buffer[offset + 1];
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          const height = buffer.readUInt16BE(offset + 5);
          const width = buffer.readUInt16BE(offset + 7);
          return { width, height };
        }
        offset += 2 + buffer.readUInt16BE(offset + 2);
      } else {
        offset++;
      }
    }
  }
  // WEBP (VP8 simple)
  if (buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
    if (buffer.toString("ascii", 12, 16) === "VP8 ") {
      const width = (buffer[26] | (buffer[27] << 8)) & 0x3fff;
      const height = (buffer[28] | (buffer[29] << 8)) & 0x3fff;
      return { width, height };
    }
  }
  return null;
}

/** Fetch an image URL and read its dimensions from the header. */
export async function getImageDimensions(imageUrl) {
  const res = await fetch(imageUrl);
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  return dimensionsFromBuffer(buf);
}

export function isValidVeoAspectRatio(width, height) {
  const ratio = width / height;
  const tol = 0.05;
  return Math.abs(ratio - 16 / 9) < tol || Math.abs(ratio - 9 / 16) < tol;
}

export function getClosestVeoAspectRatio(width, height) {
  const ratio = width / height;
  return Math.abs(ratio - 16 / 9) < Math.abs(ratio - 9 / 16) ? "16:9" : "9:16";
}

/** Canvas size + centered offset to outpaint an image to a target aspect ratio. */
export function calculateExpandCanvas(targetAspectRatio, originalWidth, originalHeight) {
  let canvasWidth;
  let canvasHeight;
  const currentRatio = originalWidth / originalHeight;
  const targetRatio = targetAspectRatio === "16:9" ? 16 / 9 : 9 / 16;

  if (targetAspectRatio === "16:9") {
    if (currentRatio < targetRatio) {
      canvasHeight = originalHeight;
      canvasWidth = Math.ceil((canvasHeight * 16) / 9);
    } else {
      canvasWidth = originalWidth;
      canvasHeight = Math.ceil((canvasWidth * 9) / 16);
    }
  } else {
    if (currentRatio > targetRatio) {
      canvasWidth = originalWidth;
      canvasHeight = Math.ceil((canvasWidth * 16) / 9);
    } else {
      canvasHeight = originalHeight;
      canvasWidth = Math.ceil((canvasHeight * 9) / 16);
    }
  }

  const maxDimension = 5000;
  if (canvasWidth > maxDimension || canvasHeight > maxDimension) {
    const scale = Math.min(maxDimension / canvasWidth, maxDimension / canvasHeight);
    canvasWidth = Math.floor(canvasWidth * scale);
    canvasHeight = Math.floor(canvasHeight * scale);
  }

  const xOffset = Math.floor((canvasWidth - originalWidth) / 2);
  const yOffset = Math.floor((canvasHeight - originalHeight) / 2);
  return { canvasWidth, canvasHeight, xOffset, yOffset };
}

/** Heuristic: does this error look like a model content-policy rejection? */
export function isContentRestrictionError(error) {
  const msg = (error?.message || String(error)).toLowerCase();
  return (
    msg.includes("content") ||
    msg.includes("restriction") ||
    msg.includes("policy") ||
    msg.includes("violation") ||
    msg.includes("nsfw") ||
    msg.includes("safety")
  );
}
