// Закачки файлов строки ввода — дело хозяина: строка просит composer:upload { key, file },
// помощник закачивает функцией хозяина и отвечает строке ходом, номером или отказом
// (composer:upload-progress / -done / -fail). Сервера он не знает: приложение даёт
// apiUpload из client/api.js, витрина — подделку.
//
//   wireUploads(root, { upload(file, { onProgress({ loaded, total }), signal }) → Promise<{ id }> })
//     → { abortAll() }
//
// root — строка или любой её предок: отвечает помощник тому, кто спросил. Убрали файл
// (composer:upload-abort) — закачка брошена сигналом, и ответа брошенной уже не будет.
import { EVENTS } from '../../utils/constants.js';
import { emit } from '../../utils/dom.js';

const NO_ID = 'Сервер не дал номер закачки';

export function wireUploads(root, { upload }) {
  const running = new Map();
  const stop = (key) => {
    running.get(key)?.abort();
    running.delete(key);
  };

  root.addEventListener(EVENTS.composerUpload, (event) => {
    const { key, file } = event.detail ?? {};
    if (!key) return;
    const composer = event.target;
    stop(key);
    const control = new AbortController();
    running.set(key, control);
    const tell = (name, detail) => {
      if (running.get(key) === control) emit(composer, name, { key, ...detail });
    };
    const onProgress = ({ loaded, total } = {}) => {
      tell(EVENTS.composerUploadProgress, { progress: total > 0 ? loaded / total : 0 });
    };
    Promise.resolve()
      .then(() => upload(file, { onProgress, signal: control.signal }))
      .then((answer) => {
        if (!answer?.id) throw new Error(NO_ID);
        tell(EVENTS.composerUploadDone, { id: String(answer.id), kind: answer.kind, sizeBytes: answer.sizeBytes });
      })
      .catch((error) => {
        if (!control.signal.aborted) tell(EVENTS.composerUploadFail, { error: error?.message ?? String(error) });
      })
      .finally(() => {
        if (running.get(key) === control) running.delete(key);
      });
  });

  root.addEventListener(EVENTS.composerUploadAbort, (event) => stop(event.detail?.key));

  return { abortAll: () => [...running.keys()].forEach(stop) };
}
