// Módulo de descarga HLS
// Descarga manifiestos m3u8, segmentos TS, desencripta y concatena

const HLSDownloader = {
  // Función fetch personalizable (se inyecta desde background.js con cookies)
  _fetchFn: null,

  setFetchFunction(fn) {
    this._fetchFn = fn;
  },

  _fetch(url, opts = {}) {
    const fn = this._fetchFn || fetch;
    return fn(url, opts);
  },

  /**
   * Parsea un manifiesto m3u8 master y retorna las variantes disponibles
   */
  parseMasterPlaylist(content) {
    const lines = content.split('\n').map((l) => l.trim());
    const variants = [];

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('#EXT-X-STREAM-INF:')) {
        const attrs = lines[i].replace('#EXT-X-STREAM-INF:', '');
        const bandwidth = parseInt(attrs.match(/BANDWIDTH=(\d+)/)?.[1] || '0');
        const resolution = attrs.match(/RESOLUTION=(\d+x\d+)/)?.[1] || '';
        const codecs = attrs.match(/CODECS="([^"]+)"/)?.[1] || '';
        const url = lines[i + 1];

        if (url && !url.startsWith('#')) {
          variants.push({ bandwidth, resolution, codecs, url });
        }
      }
    }

    // Ordenar por bandwidth descendente (mejor calidad primero)
    variants.sort((a, b) => b.bandwidth - a.bandwidth);
    return variants;
  },

  /**
   * Parsea un manifiesto m3u8 de media y retorna los segmentos
   */
  parseMediaPlaylist(content, baseUrl) {
    const lines = content.split('\n').map((l) => l.trim());
    const segments = [];
    let encryptionKey = null;
    let encryptionIV = null;
    let encryptionKeyUrl = null;
    let targetDuration = 0;
    let mediaSequence = 0;
    let currentSegmentIndex = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (line.startsWith('#EXT-X-TARGETDURATION:')) {
        targetDuration = parseInt(line.split(':')[1]);
      }

      if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
        mediaSequence = parseInt(line.split(':')[1]);
      }

      if (line.startsWith('#EXT-X-KEY:')) {
        const method = line.match(/METHOD=([^,\n]+)/)?.[1];
        const uri = line.match(/URI="([^"]+)"/)?.[1];
        const iv = line.match(/IV=0x([a-fA-F0-9]+)/)?.[1];

        if (method && method !== 'NONE') {
          encryptionKeyUrl = uri ? this.resolveUrl(uri, baseUrl) : null;
          encryptionIV = iv || null;
          encryptionKey = { method, keyUrl: encryptionKeyUrl, iv: encryptionIV };
        } else {
          encryptionKey = null;
        }
      }

      if (line.startsWith('#EXTINF:')) {
        const duration = parseFloat(line.split(':')[1]);
        const segmentUrl = lines[i + 1];

        if (segmentUrl && !segmentUrl.startsWith('#')) {
          const fullUrl = segmentUrl.startsWith('http')
            ? segmentUrl
            : this.resolveUrl(segmentUrl, baseUrl);

          segments.push({
            index: currentSegmentIndex,
            duration,
            url: fullUrl,
            encryption: encryptionKey
              ? {
                  ...encryptionKey,
                  iv: encryptionKey.iv || this.sequenceToIV(mediaSequence + currentSegmentIndex),
                }
              : null,
          });
          currentSegmentIndex++;
        }
      }
    }

    return { targetDuration, mediaSequence, segments };
  },

  resolveUrl(relative, base) {
    if (relative.startsWith('http')) return relative;
    const url = new URL(relative, base);
    return url.href;
  },

  sequenceToIV(seq) {
    const iv = new Uint8Array(16);
    const view = new DataView(iv.buffer);
    view.setUint32(12, seq, false);
    return Array.from(iv)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  },

  async fetchEncryptionKey(keyUrl) {
    const response = await this._fetch(keyUrl);
    if (!response.ok) {
      throw new Error(`Error descargando clave de encriptación: ${response.status}`);
    }
    const keyData = await response.arrayBuffer();
    return await crypto.subtle.importKey('raw', keyData, { name: 'AES-CBC' }, false, ['decrypt']);
  },

  async decryptSegment(encryptedData, cryptoKey, ivHex) {
    const iv = new Uint8Array(ivHex.match(/.{2}/g).map((b) => parseInt(b, 16)));
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, cryptoKey, encryptedData);
    return decrypted;
  },

  /**
   * Descarga un video HLS completo
   */
  async downloadVideo(masterUrl, quality = 'best', onProgress = null, signal = null) {
    // 1. Descargar master playlist
    const masterResp = await this._fetch(masterUrl, { signal });
    if (!masterResp.ok) throw new Error(`Error descargando master playlist: ${masterResp.status}`);
    const masterContent = await masterResp.text();

    // 2. Parsear variantes
    const variants = this.parseMasterPlaylist(masterContent);
    if (variants.length === 0) throw new Error('No se encontraron variantes de video');

    // 3. Seleccionar calidad
    let selected;
    if (quality === 'best') {
      selected = variants[0];
    } else {
      selected = variants.find((v) => v.resolution.includes(quality)) || variants[0];
    }

    // 4. Descargar media playlist
    const mediaResp = await this._fetch(selected.url, { signal });
    if (!mediaResp.ok) throw new Error(`Error descargando media playlist: ${mediaResp.status}`);
    const mediaContent = await mediaResp.text();

    // 5. Parsear segmentos
    const baseUrl = selected.url.split('?')[0].replace(/\/[^/]+$/, '/');
    const { segments } = this.parseMediaPlaylist(mediaContent, baseUrl);
    if (segments.length === 0) throw new Error('No se encontraron segmentos de video');

    // 6. Descargar clave de encriptación si es necesario
    let cryptoKey = null;
    if (segments[0].encryption) {
      cryptoKey = await this.fetchEncryptionKey(segments[0].encryption.keyUrl);
    }

    // 7. Descargar y desencriptar segmentos
    const downloadedSegments = [];
    let totalBytes = 0;

    for (let i = 0; i < segments.length; i++) {
      if (signal?.aborted) throw new DOMException('Descarga cancelada', 'AbortError');

      const segment = segments[i];
      const segResp = await this._fetch(segment.url, { signal });
      if (!segResp.ok)
        throw new Error(`Error descargando segmento ${i + 1}/${segments.length}: ${segResp.status}`);

      let data = await segResp.arrayBuffer();

      if (segment.encryption && cryptoKey) {
        data = await this.decryptSegment(data, cryptoKey, segment.encryption.iv);
      }

      downloadedSegments.push(data);
      totalBytes += data.byteLength;

      if (onProgress) {
        onProgress(i + 1, segments.length, totalBytes);
      }
    }

    // 8. Concatenar todos los segmentos
    const totalLength = downloadedSegments.reduce((sum, seg) => sum + seg.byteLength, 0);
    const combined = new Uint8Array(totalLength);
    let offset = 0;
    for (const segment of downloadedSegments) {
      combined.set(new Uint8Array(segment), offset);
      offset += segment.byteLength;
    }

    return new Blob([combined], { type: 'video/mp2t' });
  },

  async getVideoInfo(masterUrl) {
    const masterResp = await this._fetch(masterUrl);
    if (!masterResp.ok) throw new Error(`Error: ${masterResp.status}`);
    const masterContent = await masterResp.text();
    const variants = this.parseMasterPlaylist(masterContent);

    return {
      qualities: variants.map((v) => ({
        resolution: v.resolution,
        bandwidth: v.bandwidth,
        bandwidthMbps: (v.bandwidth / 1000000).toFixed(1),
      })),
    };
  },
};

if (typeof self !== 'undefined') {
  self.HLSDownloader = HLSDownloader;
}
