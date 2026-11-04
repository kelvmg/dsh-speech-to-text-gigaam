# Подготовка GigaAM — контракт 0.4.0

Реализовано: автоматическое изолированное окружение и одна модель `v3_e2e_rnnt`.
Поддержанная автоматическая установка: macOS 13+ Apple Silicon. Intel Mac,
Linux и Windows пока требуют явно указанного внешнего `pythonPath` и не
объявляются протестированными.

## UX

1. Выбрать GigaAM в голосовых настройках.
2. Нажать «Download and prepare» / «Скачать и подготовить».
3. Дождаться подготовки Python, зависимостей, аудио-инструментов и модели.
4. При сбое — причина и повтор; во время работы — отмена.

Терминал, системный Python, Homebrew, git и внешний ffmpeg не требуются.
Активация ничего не скачивает и не запускает установщики.

## Существующий контракт speechToText

`preparation` предоставляет `snapshot`, `subscribe`, `prepare({downloadSource})`,
`cancel`, `dispose`. Новых step kinds в DSH не вводится:

| kind | Работа |
| --- | --- |
| `check` | Проверить скрипт; установить/проверить private runtime |
| `model` | Скачать checkpoint и tokenizer |
| `verify` | Проверить размеры и хеши |
| `load` | Прогреть модель через общую очередь worker |

Фазы: `checking`, `unprepared`, `downloading`, `loading`, `ready`, `standby`,
`failed`, `cancelled`, `cancelling`. Хеширование использует `checking` со
`step=verify`, как ожидает текущий UI. При загрузке: `resource`,
`completedBytes`, `totalBytes`. Установка пакетов имеет неопределённый прогресс
с названием текущей операции, без фиктивного процента.

Оценки карточки: 4 ГБ свободного диска, около 2 ГБ RAM, 3–20 минут.

## Runtime

Корень по умолчанию: `~/.dsh/speech-to-text/gigaam`.

- `runtime/tools/uv`: uv 0.9.7 из SHA-256-проверенного архива.
- `runtime/python/`: managed CPython 3.11.14; checksum из pinned каталога uv.
- `runtime/venv/`: частное окружение; torch/torchaudio 2.8.0, GigaAM из
  pinned commit `7447938d791c4f3e643386ee22c33777004293a5`.
- Зависимости устанавливаются из bundled lockfile с `--require-hashes`.
- ffmpeg из `imageio-ffmpeg==0.6.0` копируется в bin окружения.
- `runtime/ready.json`: fingerprint платформы, интерпретатора, lockfile и
  runtime manifest. Создаётся атомарно только после проверки imports и ffmpeg.
- `runtime/cache/`: сохраняется для повторов; system Python/PATH не меняются.

Явный `pythonPath` отключает managed установку: этот интерпретатор должен быть
готов заранее; в него никогда не устанавливаются пакеты автоматически.
Старый `venv/` из 0.3 не удаляется; существующие `models/` переиспользуются.

## Модель, сеть и безопасность

Checkpoint: 448929252 Б, MD5 `2730de7545ac43ad256485a462b0a27a`.
Tokenizer: 255336 Б, SHA-256
`828c12c991019eef952a960661f25a92d6ad279591e2ea466b4aeddf1d20a18a`.
Источник: `https://cdn.chatwm.opensmodel.sberdevices.ru/GigaAM/`.

Выбор источника в UI влияет только на модель. Runtime также обращается к GitHub,
PyPI/files.pythonhosted.org. Аудио и текст не передаются в сеть. Все загрузки
явные, с deadline и ограничением точного размера. Финальное имя появляется
только после проверки; `.part-*` удаляется при отмене/ошибке. Возобновления HTTP
Range нет: незаконченный файл качается заново, готовые проверенные файлы остаются.

Ambient `UV_*`, `PIP_*`, `PYTHONPATH`, `PYTHONHOME`, `IMAGEIO_FFMPEG_EXE`
не подменяют managed setup. Proxy/certificate окружение сохраняется. Сборочные
инструменты отдельных Python source distributions используют изолированный
build environment и HTTPS PyPI: полностью hermetic/offline сборка не заявляется.

Подготовки одного корня защищены heartbeat lock (`proper-lockfile`): crash-lock
протухает через две минуты. Утеря владения прерывает текущую операцию.
Повторный `prepare` одного экземпляра присоединяется к активной задаче.
Отмена прекращает fetch/process group; завершение дочернего процесса ожидается
до удаления временного аудио, снятия lock и запуска следующего worker.
Warmup и transcription используют одну очередь, включая передачу `device`.

## Регрессии и проверка релиза

- Model-free Node: очереди/отмена/child close, bounded downloads, deadline,
  integrity, atomic publish, runtime bootstrap/reuse/retry, lock, inspect races.
- Python unittest+numpy: 18 тестов границ chunking, прогресса, сохранения каждого
  sample и короткого хвоста, пустых записей, PATH/ffmpeg/diagnostic path.
- Реальная чистая managed установка и warmup; затем 7 smoke-тестов на short/long
  WAV, пустой записи, отмене, параллельной очереди и отсутствующем интерпретаторе.
- Реальные smoke-тесты повторены с минимальным PATH без Homebrew.

Кэш проверяется при активации без imports/загрузки модели: `standby` означает
наличие файлов и marker, а не постоянную модель в RAM. На явном prepare runtime
дополнительно проверяется imports+ffmpeg, модель — хешами и warmup.
