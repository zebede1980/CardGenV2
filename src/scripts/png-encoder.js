// PNG Encoder for SillyTavern Character Cards
class PNGEncoder {
  constructor() {
    this.PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    this.config = window.config;
  }

  // Create a PNG file from image blob and embed character data
  // Writes both a ccv3 chunk (V3 primary) and a chara chunk (V2 backward-compat)
  async createCharacterCard(imageBlob, characterData) {
    try {
      // Build V3 JSON for the ccv3 chunk (primary)
      const v3Json = JSON.stringify(characterData);
      const v3Bytes = new TextEncoder().encode(v3Json);
      const base64V3 = this._bytesToBase64(v3Bytes);

      // Build V2-compat JSON for the chara chunk (backward compatibility)
      const v2Data = JSON.parse(v3Json);
      v2Data.spec = "chara_card_v2";
      v2Data.spec_version = "2.0";
      delete v2Data.data.group_only_greetings;
      delete v2Data.data.assets;
      delete v2Data.data.creation_date;
      delete v2Data.data.modification_date;
      delete v2Data.data.nickname;
      if (v2Data.data.character_book && Array.isArray(v2Data.data.character_book.entries)) {
        v2Data.data.character_book.entries.forEach((e) => delete e.use_regex);
      }
      const v2Json = JSON.stringify(v2Data);
      const v2Bytes = new TextEncoder().encode(v2Json);
      const base64V2 = this._bytesToBase64(v2Bytes);

      const pngBlob = await this.injectMetadataIntoPNG(imageBlob, base64V2, base64V3);
      return pngBlob;
    } catch (error) {
      console.error("Error creating character card:", error);
      throw error;
    }
  }

  // Inject metadata into existing PNG (more efficient than recreating)
  // Writes a chara chunk (V2 compat) and a ccv3 chunk (V3 primary) before IEND
  async injectMetadataIntoPNG(pngBlob, base64V2, base64V3) {
    try {
      console.log("🔍 Starting PNG metadata injection");
      console.log("📏 Input blob size:", pngBlob.size, "bytes");

      // Validate blob before attempting to read
      if (!pngBlob || !(pngBlob instanceof Blob)) {
        throw new Error("Invalid blob provided");
      }

      const arrayBuffer = await pngBlob.arrayBuffer();

      // Validate arrayBuffer was successfully obtained
      if (!arrayBuffer || arrayBuffer.byteLength === 0) {
        throw new Error("Failed to read blob data");
      }

      const data = new Uint8Array(arrayBuffer);

      // Verify PNG signature
      if (!this.verifyPNGSignature(data)) {
        throw new Error("Invalid PNG file - using full recreation");
      }

      // Remove any existing chara/ccv3 chunks to prevent duplicates
      const cleanedData = this.removeExistingCharaChunks(data);

      // Find the position to insert the tEXt chunks (before IEND)
      const iendPosition = this.findIENDPosition(cleanedData);
      if (iendPosition === -1) {
        throw new Error(
          "Could not find IEND chunk in PNG - using full recreation",
        );
      }

      // Create both metadata chunks
      const charaChunk = this.createtEXtChunk("chara", base64V2); // V2 backward compat
      const ccv3Chunk = this.createtEXtChunk("ccv3", base64V3);   // V3 primary
      const extraLen = charaChunk.length + ccv3Chunk.length;

      // Build new PNG: [existing data up to IEND] + [chara chunk] + [ccv3 chunk] + [IEND]
      const newPngData = new Uint8Array(cleanedData.length + extraLen);
      newPngData.set(cleanedData.slice(0, iendPosition), 0);
      newPngData.set(charaChunk, iendPosition);
      newPngData.set(ccv3Chunk, iendPosition + charaChunk.length);
      newPngData.set(cleanedData.slice(iendPosition), iendPosition + extraLen);

      return new Blob([newPngData], { type: "image/png" });
    } catch (error) {
      // Fallback: recreate PNG from canvas data
      const imageData = await this.blobToImageData(pngBlob);
      return await this.createPNGWithMetadata(imageData, base64V2, base64V3);
    }
  }

  // Remove existing metadata chunks to prevent duplicates
  removeExistingCharaChunks(data) {
    const newData = [];
    let offset = this.PNG_SIGNATURE.length;
    let charaChunksFound = 0;
    let textChunksFound = 0;

    // Copy PNG signature
    newData.push(...data.slice(0, this.PNG_SIGNATURE.length));

    while (offset < data.length - 12) {
      if (offset + 8 > data.length) {
        break;
      }

      // Read chunk length
      const length =
        (data[offset] << 24) |
        (data[offset + 1] << 16) |
        (data[offset + 2] << 8) |
        data[offset + 3];

      // Safety check to prevent infinite loops and malformed chunks
      if (length < 0 || offset + 12 + length > data.length) {
        console.warn(
          "Encountered malformed PNG chunk while cleaning metadata.",
        );
        break;
      }

      // Read chunk type
      const type = String.fromCharCode(
        data[offset + 4],
        data[offset + 5],
        data[offset + 6],
        data[offset + 7],
      );

      const chunkSize = 4 + 4 + length + 4; // length + type + data + CRC

      // Skip ALL tEXt chunks that carry character metadata (chara, ccv3) to prevent duplicates
      const isTExt = type === "tEXt";
      let isCharaMeta = type === "chara";
      if (isTExt && !isCharaMeta) {
        // Peek at the keyword to see if it's ccv3
        if (offset + 8 + 4 <= data.length) {
          const kw = String.fromCharCode(
            data[offset + 8], data[offset + 9], data[offset + 10], data[offset + 11]
          );
          if (kw === "ccv3") isCharaMeta = true;
        }
      }
      if (!isTExt && type !== "chara") {
        newData.push(...data.slice(offset, offset + chunkSize));
      } else {
        if (type === "chara" || isCharaMeta) {
          charaChunksFound++;
        } else if (type === "tEXt") {
          textChunksFound++;
        }
      }

      // Move to next chunk
      offset += chunkSize;
    }

    return new Uint8Array(newData);
  }

  // Find the position of the IEND chunk
  findIENDPosition(data) {
    let offset = this.PNG_SIGNATURE.length;

    while (offset < data.length - 12) {
      // Read chunk length
      const length =
        (data[offset] << 24) |
        (data[offset + 1] << 16) |
        (data[offset + 2] << 8) |
        data[offset + 3];

      // Read chunk type
      const type = String.fromCharCode(
        data[offset + 4],
        data[offset + 5],
        data[offset + 6],
        data[offset + 7],
      );

      if (type === "IEND") {
        return offset;
      }

      // Move to next chunk (4 bytes length + 4 bytes type + data + 4 bytes CRC)
      offset += 4 + 4 + length + 4;
    }

    return -1;
  }

  // Convert blob to ImageData
  async blobToImageData(blob) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(blob);

      img.onload = () => {
        try {
          const canvas = document.createElement("canvas");
          const ctx = canvas.getContext("2d");

          canvas.width = img.width;
          canvas.height = img.height;

          ctx.drawImage(img, 0, 0);

          const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          URL.revokeObjectURL(url);

          resolve({
            data: imageData.data,
            width: canvas.width,
            height: canvas.height,
          });
        } catch (error) {
          URL.revokeObjectURL(url);
          console.error("Error in blobToImageData:", error);
          reject(error);
        }
      };

      img.onerror = () => {
        URL.revokeObjectURL(url);
        console.error("Failed to load image from blob");
        reject(new Error("Failed to load image"));
      };

      img.src = url;
    });
  }

  // Create PNG with metadata chunks (fallback path)
  async createPNGWithMetadata(imageData, base64V2, base64V3) {
    const chunks = [];

    // IHDR chunk (image header)
    const ihdrData = this.createIHDRChunk(imageData.width, imageData.height);
    chunks.push(ihdrData);

    // IDAT chunks (image data)
    const idatChunks = await this.createIDATChunks(imageData);
    chunks.push(...idatChunks);

    // V2 backward-compat chunk
    chunks.push(this.createtEXtChunk("chara", base64V2));
    // V3 primary chunk
    chunks.push(this.createtEXtChunk("ccv3", base64V3));

    // IEND chunk (image end)
    chunks.push(this.createIENDChunk());

    // Combine all chunks
    const pngData = this.combinePNGChunks(chunks);

    return new Blob([pngData], { type: "image/png" });
  }

  // Create IHDR chunk
  createIHDRChunk(width, height) {
    const data = new Uint8Array(13);

    // Width (4 bytes, big endian)
    data[0] = (width >>> 24) & 0xff;
    data[1] = (width >>> 16) & 0xff;
    data[2] = (width >>> 8) & 0xff;
    data[3] = width & 0xff;

    // Height (4 bytes, big endian)
    data[4] = (height >>> 24) & 0xff;
    data[5] = (height >>> 16) & 0xff;
    data[6] = (height >>> 8) & 0xff;
    data[7] = height & 0xff;

    // Bit depth (1 byte)
    data[8] = 8; // 8 bits per sample

    // Color type (1 byte) - 2 = RGB, 6 = RGBA
    data[9] = 6; // RGBA

    // Compression method (1 byte)
    data[10] = 0; // Deflate

    // Filter method (1 byte)
    data[11] = 0; // Adaptive filtering

    // Interlace method (1 byte)
    data[12] = 0; // No interlace

    return this.createPNGChunk("IHDR", data);
  }

  // Create IDAT chunks (compressed image data)
  async createIDATChunks(imageData) {
    // Convert RGBA to PNG format
    const pngData = this.convertRGBAToPNG(imageData);

    // Compress data properly
    const compressed = await this.compressData(pngData);

    // Split into chunks if necessary (PNG has a 2^31 byte limit per chunk)
    const maxChunkSize = 1024 * 1024; // 1MB chunks
    const chunks = [];

    for (let i = 0; i < compressed.length; i += maxChunkSize) {
      const chunkData = compressed.slice(i, i + maxChunkSize);
      chunks.push(this.createPNGChunk("IDAT", chunkData));
    }

    return chunks;
  }

  // Convert RGBA to PNG scanline format
  convertRGBAToPNG(imageData) {
    const { data, width, height } = imageData;
    const pngData = new Uint8Array(width * height * 4 + height);
    let pngIndex = 0;

    for (let y = 0; y < height; y++) {
      // Add filter type byte (0 = None)
      pngData[pngIndex++] = 0;

      // Add scanline data
      for (let x = 0; x < width; x++) {
        const srcIndex = (y * width + x) * 4;
        pngData[pngIndex++] = data[srcIndex]; // R
        pngData[pngIndex++] = data[srcIndex + 1]; // G
        pngData[pngIndex++] = data[srcIndex + 2]; // B
        pngData[pngIndex++] = data[srcIndex + 3]; // A
      }
    }

    return pngData;
  }

  // Create text chunk for metadata (returns raw chunk with length and CRC)
  createtEXtChunk(keyword, text) {
    const keywordBytes = new TextEncoder().encode(keyword);
    const textBytes = new TextEncoder().encode(text);

    // Combine keyword and text with null separator
    const data = new Uint8Array(keywordBytes.length + 1 + textBytes.length);
    data.set(keywordBytes, 0);
    data[keywordBytes.length] = 0; // Null separator
    data.set(textBytes, keywordBytes.length + 1);

    return this.createPNGChunk("tEXt", data);
  }

  // Create IEND chunk
  createIENDChunk() {
    return this.createPNGChunk("IEND", new Uint8Array(0));
  }

  // Create a PNG chunk with CRC
  createPNGChunk(type, data) {
    const typeBytes = new TextEncoder().encode(type);

    // Create chunk data: type + data
    const chunkData = new Uint8Array(typeBytes.length + data.length);
    chunkData.set(typeBytes, 0);
    chunkData.set(data, typeBytes.length);

    // Calculate CRC
    const crc = this.calculateCRC(chunkData);

    // Create complete chunk: length + data + CRC
    const length = data.length;
    const chunk = new Uint8Array(4 + chunkData.length + 4);

    // Length (big endian)
    chunk[0] = (length >>> 24) & 0xff;
    chunk[1] = (length >>> 16) & 0xff;
    chunk[2] = (length >>> 8) & 0xff;
    chunk[3] = length & 0xff;

    // Chunk data
    chunk.set(chunkData, 4);

    // CRC (big endian)
    const crcIndex = 4 + chunkData.length;
    chunk[crcIndex] = (crc >>> 24) & 0xff;
    chunk[crcIndex + 1] = (crc >>> 16) & 0xff;
    chunk[crcIndex + 2] = (crc >>> 8) & 0xff;
    chunk[crcIndex + 3] = crc & 0xff;

    return chunk;
  }

  // Calculate CRC for PNG chunk
  calculateCRC(data) {
    let crc = 0xffffffff;

    for (let i = 0; i < data.length; i++) {
      crc = crc32Table[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
    }

    return (crc ^ 0xffffffff) >>> 0;
  }

  // Combine all PNG chunks into final file
  combinePNGChunks(chunks) {
    // Calculate total size
    let totalSize = this.PNG_SIGNATURE.length;
    chunks.forEach((chunk) => {
      totalSize += chunk.length;
    });

    // Create final PNG
    const pngData = new Uint8Array(totalSize);
    let offset = 0;

    // Add signature
    pngData.set(this.PNG_SIGNATURE, offset);
    offset += this.PNG_SIGNATURE.length;

    // Add all chunks
    chunks.forEach((chunk) => {
      pngData.set(chunk, offset);
      offset += chunk.length;
    });

    return pngData;
  }

  // Compress data using browser's deflate API
  async compressData(data) {
    try {
      // Use CompressionStream for proper deflate compression
      const compressionStream = new CompressionStream("deflate");
      const writer = compressionStream.writable.getWriter();
      const reader = compressionStream.readable.getReader();

      // Write data to compressor
      writer.write(data);
      writer.close();

      // Read compressed data
      const chunks = [];
      let done = false;

      while (!done) {
        const { value, done: readerDone } = await reader.read();
        done = readerDone;
        if (value) {
          chunks.push(value);
        }
      }

      // Combine all chunks
      let totalLength = 0;
      chunks.forEach((chunk) => (totalLength += chunk.length));

      const result = new Uint8Array(totalLength);
      let offset = 0;
      chunks.forEach((chunk) => {
        result.set(chunk, offset);
        offset += chunk.length;
      });

      return result;
    } catch (error) {
      console.warn("Compression failed, using uncompressed data:", error);
      return new Uint8Array(data);
    }
  }

  // Analyze PNG chunks for debugging
  async analyzePNGChunks(pngBlob) {
    try {
      const arrayBuffer = await pngBlob.arrayBuffer();
      const data = new Uint8Array(arrayBuffer);

      if (!this.verifyPNGSignature(data)) {
        return;
      }

      let offset = this.PNG_SIGNATURE.length;
      let chunkCount = 0;
      let charaChunks = [];

      while (offset < data.length - 12) {
        const length =
          (data[offset] << 24) |
          (data[offset + 1] << 16) |
          (data[offset + 2] << 8) |
          data[offset + 3];
        const type = String.fromCharCode(
          data[offset + 4],
          data[offset + 5],
          data[offset + 6],
          data[offset + 7],
        );

        chunkCount++;

        if (type === "chara") {
          const chunkData = data.slice(offset + 8, offset + 8 + length);
          const text = new TextDecoder().decode(chunkData);
          charaChunks.push({ offset, length, text });
        } else if (type === "tEXt") {
          const chunkData = data.slice(offset + 8, offset + 8 + length);
          const text = new TextDecoder().decode(chunkData);
          // Check if this tEXt chunk contains chara data (starts with "chara\0")
          if (text.startsWith("chara\0")) {
            const charaData = text.substring(6); // Remove "chara\0" prefix
            charaChunks.push({ offset, length, text: charaData });
          }
        }

        if (type === "IEND") {
          break;
        }

        // Safety check to prevent infinite loops
        if (length < 0 || length > data.length - offset - 12) {
          break;
        }

        offset += 4 + 4 + length + 4; // length + type + data + CRC
      }

      return { chunkCount, charaChunks };
    } catch (error) {
      // Silently handle analysis errors
    }
  }

  // Download the character card
  downloadCharacterCard(blob, characterName) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = `${characterName.replace(/[^a-zA-Z0-9\s]/g, "").trim() || "character"}_card.png`;

    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    // Clean up
    setTimeout(() => URL.revokeObjectURL(url), 100);
  }

  // Extract character data from existing PNG
  // Prefers the ccv3 chunk (V3) over the chara chunk (V2)
  async extractCharacterData(pngBlob) {
    try {
      const arrayBuffer = await pngBlob.arrayBuffer();
      const data = new Uint8Array(arrayBuffer);

      // Verify PNG signature
      if (!this.verifyPNGSignature(data)) {
        throw new Error("Invalid PNG file");
      }

      // Parse chunks
      const chunks = this.parsePNGChunks(data);

      // Collect all tEXt chunks, keyed by keyword
      const textChunks = {};
      for (const chunk of chunks) {
        if (chunk.type === "tEXt") {
          const textData = this.parsetEXtChunk(chunk.data);
          textChunks[textData.keyword.toLowerCase()] = textData.text;
        }
      }

      // Prefer ccv3 (V3), fall back to chara (V2)
      const raw = textChunks["ccv3"] || textChunks["chara"];
      if (!raw) {
        throw new Error("No character data found in PNG");
      }

      try {
        const jsonText = this.decodeBase64Utf8(raw);
        return JSON.parse(jsonText);
      } catch (e) {
        // Not base64 — try plain text
        return JSON.parse(raw);
      }
    } catch (error) {
      console.error("Error extracting character data:", error);
      throw error;
    }
  }

  verifyPNGSignature(data) {
    if (data.length < this.PNG_SIGNATURE.length) return false;

    for (let i = 0; i < this.PNG_SIGNATURE.length; i++) {
      if (data[i] !== this.PNG_SIGNATURE[i]) return false;
    }

    return true;
  }

  parsePNGChunks(data) {
    const chunks = [];
    let offset = this.PNG_SIGNATURE.length;

    while (offset < data.length) {
      // Read chunk length
      const length =
        (data[offset] << 24) |
        (data[offset + 1] << 16) |
        (data[offset + 2] << 8) |
        data[offset + 3];
      offset += 4;

      // Read chunk type
      const type = String.fromCharCode(...data.slice(offset, offset + 4));
      offset += 4;

      // Read chunk data
      const chunkData = data.slice(offset, offset + length);
      offset += length;

      // Skip CRC
      offset += 4;

      chunks.push({
        type,
        data: chunkData,
        length,
      });

      // Break if IEND chunk
      if (type === "IEND") break;
    }

    return chunks;
  }

  parsetEXtChunk(data) {
    const nullIndex = data.indexOf(0);
    const keyword = new TextDecoder().decode(data.slice(0, nullIndex));
    const text = new TextDecoder().decode(data.slice(nullIndex + 1));

    return { keyword, text };
  }

  decodeBase64Utf8(base64Text) {
    const binary = atob(base64Text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder("utf-8").decode(bytes);
  }

  /**
   * Convert a Uint8Array to base64 without using spread operator,
   * avoiding call-stack overflow on large payloads (>100KB).
   */
  _bytesToBase64(bytes) {
    const CHUNK_SIZE = 0x8000; // 32KB chunks
    let binary = "";
    for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
      binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK_SIZE));
    }
    return btoa(binary);
  }
}

// CRC32 lookup table (standard PNG)
const crc32Table = (() => {
  const table = new Array(256);

  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c;
  }

  return table;
})();

// Export singleton instance
window.pngEncoder = new PNGEncoder();
