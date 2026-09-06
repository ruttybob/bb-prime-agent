# prime-agent provider for bb

Проект делает prime-agent полноценным провайдером bb через native provider-плагин: весь рабочий функционал prime-agent CLI доступен из bb, включая управление субагентами. Здесь — доменные термины интеграции.

## Language

### Интеграция

**Provider bridge**:
Процесс bb-плагина, переводящий Provider Bridge Protocol bb в вызовы prime-agent и обратно.
_Avoid_: ACP-bridge, адаптер

**Daemon**:
Фоновый сервис prime-agent, владеющий resident-сессиями; переживает отключение клиентов.
_Avoid_: supervisor, background service

**Daemon protocol**:
Собственный JSONL-протокол daemon prime-agent; надмножество команд RPC-режима. Наш bridge говорит на нём.
_Avoid_: RPC (в смысле транспорта bridge)

### Сессии

**Resident session**:
Сессия prime-agent под опекой daemon; живёт независимо от подключённых клиентов, подключение возможно позже. Модель для bb-потоков.
_Avoid_: detached session, фоновая сессия

**Client-owned session**:
Сессия, чья жизнь привязана к клиенту-владельцу: daemon убирает её после отсоединения владельца. Bb-потоки никогда не создают таких сессий — единственное намеренное исключение, задокументированное в `src/model-catalog.ts`, это одноразовая lane чтения каталога моделей: короткоживущая lane под один запрос, умирающая вместе с подключением — bridge убивает её сразу после ответа, а при обрыве подключения сессию убирает daemon.
_Avoid_: временная сессия

**Session lease**:
Файловая блокировка сессии между процессами. К подключению клиентов отношения не имеет — attach не эксклюзивен.
_Avoid_: exclusive attach, «аренда сессии»

**Snapshot replay**:
Заполнение ленты подключившегося клиента срезом снапшота сессии; события, пропущенные до подключения, не доигрываются.
_Avoid_: catch-up, догоняющий стрим

### Harness-поверхности (v2)

**Thread goal**:
Цель resident-сессии (`/goal …` в prime): objective, статус (active/paused/budget_limited/complete) и учёт токенов/времени. Bridge читает её из `state.goal` снапшота и live-событий `goal_update` (RPC на goal нет); в bb она видна рядом `prime-agent/goal`, очистка идёт командой `/goal clear` — отдельного RPC тоже нет.
_Avoid_: «цель потока bb» (у bb своей цели нет)

**Heartbeat**:
Повторяющееся задание сессии в daemon'е (user-heartbeat сессии или agent-heartbeat субагента — `source` у job). Доставка при занятой сессии: `steer` или `follow_up`. Управляется Heartbeats-панелью поверх RPC `heartbeat_*`; изменения приходят глобальным push `heartbeats_changed` без id сессии.
_Avoid_: «крон» (у расписок отдельный термин)

**Schedule (prime-side)**:
Расписка уровня daemon (`source: "cron"`, команды `cron_*`): промпт доставляется в resident-сессию по расписанию. От слова «расписка» в bb-automations отличается именно resident-доставкой (ADR-0004); живёт в той же Heartbeats-панели отдельной секцией.
_Avoid_: automation (это про bb automations), крон-джоб без уточнения

### Субагенты

**Subagent (RLM child)**:
Дочерний агент, порождённый вызовом `rlm(...)` в Python REPL родительской сессии; имеет собственную сессию и идентификатор.
_Avoid_: child thread, воркер

**Subagent control**:
Управление работающим субагентом из bb — steering-сообщение или остановка. Обязательный уровень интеграции v1.
_Avoid_: «перехват» без уточнения
