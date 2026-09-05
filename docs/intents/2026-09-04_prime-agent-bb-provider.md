# Intent: prime-agent как родной провайдер bb

Date: 2026-09-04
Status: accepted

## Problem

prime-agent — мощный агент (RLM, субагенты, daemon, долгие автономные циклы), но работать с ним можно только в его собственном TUI/CLI. bb — место, где реально идёт оркестрация работы (потоки, окружения, ревью) — про prime-agent не знает: из коробки там родные codex/claude-code/pi и генерический ACP. Приходится выходить из bb, чтобы рулить агентом, а субагенты из bb вообще не видны и не управляемы. ACP-подключение не спасает: оно переносит только «чат с агентом», а не цикл управления.

## Proposed outcome

prime-agent появляется в bb как первоклассный провайдер: потоки bb живут на его resident-сессиях, весь рабочий цикл CLI доступен из bb (steer/follow_up, fork, compact, модели, thinking, скиллы), субагенты видны в потоке и управляемы (steer/stop) из панели. Сессии переживают рестарт bb и остаются видны/аттачабельны из prime TUI — управлять агентом можно с любой стороны.

## Affected users and systems

- Первичный пользователь — автор плагина; структура сразу «как публикуемый», чтобы позже выложить в bb-community marketplace.
- Затронуто: этот репо (сам плагин), host-daemon bb (исполняет bridge-артефакт плагина), prime-agent daemon на каждой машине, общий каталог сессий `~/.prime/agent`.

## Constraints

- Единственная поверхность расширения bb — Plugin SDK (provider bridge, protocol version 2, экспериментальные `experimental_`-API могут меняться между версиями bb).
- Daemon-протокол prime-agent — не публичный контракт: schema revision дрейфует (в 0.7.3 — rev 16, в master — 23); обязательны capability-gating по `daemon_hello` и предупреждения вместо блокировок.
- Trust-модель prime-agent: без песочницы, model-generated код исполняется с правами пользователя — bb-сторонние gate'ы не добавляем.
- prime-agent должен быть установлен и залогинен на каждой машине; bb его не устанавливает.
- Лицензия: репо get-bb/bb — MIT, код builtin-плагинов заимствовать можно с сохранением copyright; в опубликованных npm-артефактах license-поля отсутствуют — быть аккуратным с атрибуцией.

## Decisions

- Native provider-плагин, не ACP — ACP не выражает steer/fork/субагентов/heartbeats, `_meta` пассивен (ADR-0001).
- Транспорт bridge — прямой клиент daemon-протокола (`create lifecycle:"resident"`), не обёртка над `--mode rpc` — RPC-child даёт client_owned-сессии, умирающие через 30 с (ADR-0002).
- v1 scope = T0 (паритет pi-provider: чат/стрим/tools, steer+follow_up, fork, compact, модели+thinking, скиллы в `/`-меню, персистентность) + T1 (prime read-only: список субагентов со статусами, статус goal, autonomous-бюджеты, ipython-ячейки как tool items) + subagent control — задача bbpa-ydo.
- v2 (осознанно отложено): goal set/clear, heartbeats, schedules, `/refine`, запуск autonomous, UI-attach к сессиям, полный транскрипт субагента.
- Сессии — daemon-resident, строго 1:1 с bb-потоком, cwd = путь environment потока.
- release (stop потока) = мягкий stop агента, файл сессии сохраняется; discard = stop + уборка.
- Закрытие bb сессии не останавливает: resident-сессии продолжают жить в daemon, при открытии потока — attach + снапшот.
- Созданные bb сессии живут в общем каталоге prime с префиксом имени `[bb] ` — видны и аттачабельны из prime TUI.
- Субагенты: панель в bb-потоке (список, статусы, кнопки steer/stop) + delegation items в таймлайне; stop субагента v1 = cancel, без удаления из ledger.
- bb+TUI на одной сессии: бейдж «ещё N подключённых клиентов», без блокировок — эксклюзивной паузы ввода в 0.7.3 нет.
- Trust: `permissionModes: ["full"]` + честный копирайт «no sandbox», никаких bb-side подтверждений turn'а.
- Видимость провайдера: только при установленном `prime-agent` (health-проба), `installUrl` на официальный установщик, своего инсталлера нет.
- Версии prime: health-проба возвращает версию; при дрейфе протокола — предупреждение в UI, потоки не блокируем; жёсткая отсечка только на ломающие мажоры.
- Расширения: v1 спавн с `-ne` (discovery пользовательских extensions выключена), skills discovery включена; собственный bridge-extension грузится явным `-e`; пикер расширений в настройках провайдера — обязательное продолжение.
- Свой prime-extension пишем сами (форк bb-шного `bb-pi-extension`): механизм `PI_BB_TOOLS_FILE` в prime 0.7.3 отсутствует, dynamic tools нужно портировать.
- Конфиги не конфликтуют: prime живёт в `~/.prime/agent`, отдельно от `~/.pi/agent` — сосуществование с pi безопасно.
- Обновление/рестарт daemon посреди работы переживается: reconnect + повторный attach со снапшотом (штатное восстановление prime).
- Чужой stale-daemon (несовместимый протокол, busy-сессии мешают замене) — предупреждение провайдера, чужой daemon не трогаем.
- Дом плагина — этот репо; термины в `CONTEXT.md`, решения в `docs/adr/`.

## Rejected

- ACP generic dialect — дёшево, но теряется именно цель интеграции: управление циклом и субагентами.
- ACP + prime `_meta`-dialect — тот же объём работы, что свой bridge, при меньших возможностях.
- RPC-child транспорт (паттерн pi-bridge) — client_owned-сессии умирают через 30 с, resident-модель невыполнима.
- Invocation-local сессии (pi-стиль, отклонено в пользу daemon-resident) — привязывают жизнь агента к процессу bb.
- bb-side gate'ы/подтверждения перед turn'ом — ломают автономный цикл, ради которого prime и нужен.
- Собственный инсталлер prime внутри bb — дублирует официальный установщик.
- Жёсткий пин версий prime — prime развивается быстро, предупреждение лучше блокировки.
- Субагенты как отдельные bb child-треды и запуск субагентов из bb UI — дублируют RLM-модель, где субагент — программный вызов, а не UI-сущность.
- Эксклюзивная блокировка водителей — недоступна в 0.7.3, хрупко; выбран бейдж.
- Изолированный каталог bb-сессий (`~/.bb/prime-bridge-sessions`) — лишает TUI-видимости, которая и есть смысл resident-модели.

## Open questions

- Спайк: как параметры `create` daemon-протокола передают per-session настройки (аналог `-ne`, скиллы, расширения) — на уровне сессии или только settings.json.
- Спайк: канал dynamic tools bb → prime (кандидат — MCP-мост через `replace_acp_mcp_servers`).
- Спайк: наличие `cancel_rlm_child` в 0.7.3 (в master есть; если нет — чем останавливать субагента).
- Форма пикера расширений в настройках провайдера (какие данные показывает, как мапится на повторные `-e`).
- Черновик именования провайдера: id `prime-agent`, displayName `Prime Agent` — подтвердить при спеке.

## Sources

- `CONTEXT.md` — глоссарий (resident/client-owned session, daemon protocol, session lease, snapshot replay, subagent control).
- `docs/adr/0001-native-bridge-over-acp.md`, `docs/adr/0002-daemon-protocol-transport.md`.
- bd: `bbpa-ydo` — скоуп v1 и полный лог резолюций гриллинга (`bd show bbpa-ydo`).
- Исследование daemon-протокола и bb Plugin SDK — сессия от 2026-09-04; несущие факты сведены в ADR-0002 и заметки bbpa-ydo (daemon-протокол = надмножество RPC; attach не эксклюзивен; replay снапшотом; автостарт daemon; субагенты в snapshot.children; RPC-mode создаёт client_owned).
- Факты о совместимости extension API (pi ↔ prime 0.7.3) и лицензии MIT репо get-bb/bb — та же сессия.
