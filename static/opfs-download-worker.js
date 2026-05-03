self.onmessage = (event) => {
  const message = event.data || {};
  if (message.type === 'START') {
    runDownload(message).catch((error) => {
      self.postMessage({
        type: 'ERROR',
        error: error?.message || 'Falha no worker de download',
      });
    });
    return;
  }

  if (!currentState) return;

  if (message.type === 'PAUSE') {
    currentState.pauseRequested = true;
    abortActiveRequests();
    return;
  }

  if (message.type === 'CANCEL') {
    currentState.cancelRequested = true;
    currentState.cleanupOnCancel = message.cleanup !== false;
    abortActiveRequests();
  }
};

let currentState = null;

function cloneParts(parts = []) {
  return parts.map((part) => ({
    index: part.index,
    start: part.start,
    end: part.end,
    written: part.written || 0,
    status: part.status || 'pending',
  }));
}

function sumWrittenBytes(parts = []) {
  return parts.reduce((total, part) => total + (part.written || 0), 0);
}

function abortActiveRequests() {
  if (!currentState) return;
  for (const controller of currentState.controllers) {
    controller.abort();
  }
}

function buildSnapshot(type, extra = {}) {
  return {
    type,
    bytesWritten: currentState?.bytesWritten || 0,
    totalBytes: currentState?.totalBytes || 0,
    parts: cloneParts(currentState?.parts || []),
    ...extra,
  };
}

function emitProgress(force = false, status = 'downloading') {
  if (!currentState) return;
  const now = Date.now();
  if (!force && now - currentState.lastEmitAt < 350) return;

  const elapsed = Math.max(0.001, (now - currentState.lastSpeedAt) / 1000);
  const delta = currentState.bytesWritten - currentState.lastSpeedBytes;
  const speed = delta > 0 ? delta / elapsed : 0;
  const remaining = Math.max(0, currentState.totalBytes - currentState.bytesWritten);
  const eta = speed > 0 ? Math.round(remaining / speed) : null;

  currentState.lastEmitAt = now;
  currentState.lastSpeedAt = now;
  currentState.lastSpeedBytes = currentState.bytesWritten;

  self.postMessage(buildSnapshot('PROGRESS', { status, speed, eta }));
}

async function createWriter(fileHandle, totalBytes) {
  if (typeof fileHandle.createSyncAccessHandle === 'function') {
    const syncHandle = await fileHandle.createSyncAccessHandle();
    try {
      syncHandle.truncate(totalBytes);
    } catch (error) {
      // Safari may reject truncate on resumed files; ignore and keep writing.
    }
    return {
      async write(position, data) {
        syncHandle.write(data, { at: position });
      },
      async close() {
        try {
          syncHandle.flush();
        } catch (error) {
        }
        syncHandle.close();
      },
      async abort() {
        syncHandle.close();
      },
    };
  }

  const writable = await fileHandle.createWritable({ keepExistingData: true });
  try {
    await writable.truncate(totalBytes);
  } catch (error) {
    // Some engines reject truncate during resume; keep the previous data.
  }

  let writeChain = Promise.resolve();
  return {
    async write(position, data) {
      writeChain = writeChain.then(() => writable.write({ type: 'write', position, data }));
      await writeChain;
    },
    async close() {
      await writeChain;
      await writable.close();
    },
    async abort() {
      try {
        await writable.abort();
      } catch (error) {
        try {
          await writeChain;
          await writable.close();
        } catch (closeError) {
        }
      }
    },
  };
}

async function removeSandboxFile() {
  if (!currentState?.root || !currentState?.sandboxFileName) return;
  try {
    await currentState.root.removeEntry(currentState.sandboxFileName);
  } catch (error) {
    if (error?.name !== 'NotFoundError') {
      throw error;
    }
  }
}

async function downloadPart(part) {
  const startOffset = part.start + (part.written || 0);
  if (startOffset > part.end) {
    part.status = 'done';
    return;
  }

  part.status = 'downloading';
  const controller = new AbortController();
  currentState.controllers.add(controller);

  try {
    const response = await fetch(
      `${currentState.partUrlBase}/part?start=${startOffset}&end=${part.end}`,
      {
        headers: currentState.headers || {},
        signal: controller.signal,
      }
    );

    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => '');
      throw new Error(text || `HTTP ${response.status}`);
    }

    const reader = response.body.getReader();
    let position = startOffset;

    while (true) {
      if (currentState.pauseRequested || currentState.cancelRequested) {
        throw new DOMException('Aborted', 'AbortError');
      }

      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.length === 0) continue;

      await currentState.writer.write(position, value);
      position += value.length;
      part.written = (part.written || 0) + value.length;
      currentState.bytesWritten += value.length;
      emitProgress(false, 'downloading');
    }

    part.status = 'done';
  } finally {
    currentState.controllers.delete(controller);
  }
}

async function runDownload(config) {
  const parts = cloneParts(config.parts || []);
  const totalBytes = Number(config.totalBytes) || 0;
  currentState = {
    sandboxFileName: config.sandboxFileName,
    partUrlBase: config.partUrlBase,
    headers: config.headers || {},
    parts,
    totalBytes,
    bytesWritten: sumWrittenBytes(parts),
    pauseRequested: false,
    cancelRequested: false,
    cleanupOnCancel: false,
    controllers: new Set(),
    lastEmitAt: 0,
    lastSpeedAt: Date.now(),
    lastSpeedBytes: sumWrittenBytes(parts),
    root: null,
    writer: null,
  };

  try {
    const root = await navigator.storage.getDirectory();
    const fileHandle = await root.getFileHandle(config.sandboxFileName, { create: true });
    currentState.root = root;
    currentState.writer = await createWriter(fileHandle, totalBytes);

    if (totalBytes <= 0) {
      await currentState.writer.close();
      self.postMessage(buildSnapshot('READY'));
      return;
    }

    const pendingParts = currentState.parts.filter((part) => (part.start + (part.written || 0)) <= part.end);
    await Promise.all(pendingParts.map((part) => downloadPart(part)));

    if (currentState.cancelRequested) {
      await currentState.writer.abort();
      if (currentState.cleanupOnCancel) {
        await removeSandboxFile();
      }
      self.postMessage(buildSnapshot('CANCELED'));
      return;
    }

    if (currentState.pauseRequested) {
      await currentState.writer.close();
      self.postMessage(buildSnapshot('PAUSED'));
      return;
    }

    await currentState.writer.close();
    emitProgress(true, 'downloading');
    self.postMessage(buildSnapshot('READY'));
  } catch (error) {
    const aborted = error?.name === 'AbortError';

    if (aborted && currentState?.cancelRequested) {
      try {
        await currentState.writer?.abort();
      } catch (abortError) {
      }
      if (currentState.cleanupOnCancel) {
        await removeSandboxFile();
      }
      self.postMessage(buildSnapshot('CANCELED'));
      return;
    }

    if (aborted && currentState?.pauseRequested) {
      try {
        await currentState.writer?.close();
      } catch (closeError) {
      }
      self.postMessage(buildSnapshot('PAUSED'));
      return;
    }

    try {
      await currentState?.writer?.abort();
    } catch (abortError) {
    }

    self.postMessage(buildSnapshot('ERROR', {
      error: error?.message || 'Falha ao baixar arquivo',
    }));
  } finally {
    if (currentState) {
      currentState.controllers.clear();
      currentState.writer = null;
    }
    currentState = null;
  }
}
