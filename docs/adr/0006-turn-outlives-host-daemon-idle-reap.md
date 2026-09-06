---
status: accepted
---

# Turn переживает idle-reap host-daemon'а без keep-alive со стороны плагина

Билет bbpa-1pr исходил из наблюдения «host plugin worker became idle»: host-daemon
останавливает воркер плагина после ~5 минут того, что считает простоем, и длинный
turn (8–15 минут на медленной модели) будто бы рискует потерять доставку конца
turn'а — push-поток умирает вместе с воркером, prime-daemon доигрывает прогон «в пустоту»,
а свежий воркер доигрывает только snapshot replay. Разбор механизма на bb 0.42.1
показал: у воркера, владеющего turn'ом, idle-таймера нет вовсе, и плагину нечего
«держать живым».

## Механизм (проверено по бандлу host-daemon 0.42.1 и E2E-прогоном)

У host-daemon'а два вида воркеров плагина, и idle-таймер есть только у одного:

- **Host worker** (`bb-plugin-host-worker.mjs`, IPC-ребёнок host-daemon'а) исполняет host
  RPC entry плагина — у нас это default export `host.ts` (ростер субагентов,
  heartbeats, native roots). Его и останавливает таймер «became idle»:
  `scheduleWorkerIdle` c `DEFAULT_WORKER_IDLE_TIMEOUT_MS = 5*60_000` (опция
  `workerIdleTimeoutMs`). Таймер снимают только: входящий RPC-вызов (busy-state
  `activeCallCount > 0`), lease `experimental_retainWorker()` из контекста живого
  вызова (сообщение `lease-acquire` воркер→host-daemon) и `watch-start`. Push
  воркер→host-daemon (`signal`) таймер НЕ сбрасывает — push-only активность простоем
  не считается.
- **Bridge worker** (`bb-provider-bridge-worker.mjs`, stdio-ребёнок host-daemon'а)
  исполняет `experimental_providerBridge` (`src/provider-bridge.ts`) — именно он
  владеет открытыми turn'ами и push-потоком дельт. Idle-таймера у этого процесса
  нет, и каждый путь его остановки учитывает хостируемые bb-треды:
  `releaseIdleProviderProcess` выходит, пока `identity.threadIds.size > 0`;
  retirement устаревших процессов требует нуля хостируемых тредов; рекомендованный
  restart переносится, пока по тредам идёт turn. Есть и сессионный 30-минутный
  idle-reap (`reapIdleProviderSessions`, `IDLE_PROVIDER_SESSION_REAP_AFTER_MS`):
  он пер-тредовый, mid-turn не трогает, но со временем опустошает `threadIds`
  по завершённым тредам — и тогда bridge worker останавливается уже обычным
  путём. Посреди turn'а воркер всегда хостирует минимум один тред — остановить
  его нечем.

E2E (билет bbpa-1pr, throwaway-воркспейс): prime-agent turn с foreground `sleep 420`
работал 7m13s — дольше idle-окна; bridge worker, родившийся на старте turn'а,
пережил весь span и продолжил жить после; `turn/completed` дошёл (финальное
сообщение в таймлайне, поток вернулся в idle); в host-daemon log за span не
попало ни одной остановки bridge worker'а, а host worker'ы за тот же span
честно reapились по простою и поднимались по запросу — как и до E2E.

## Решение

Bridge не держит себя живым специально: ни lease-болтовни, ни самовызовов, ни
таймеров против host-daemon'а. Idle-reap host worker'а остаётся как есть —
панельные RPC переподключаются к prime-daemon'у с нуля, а открытые панели и так считают
пропущенные signal-push'и признанной дырой и догоняют перечитыванием
(`use-heartbeats`).

Если когда-нибудь появится поверхность, для которой host worker обязан доставлять
push сквозь окно простоя (подписка, живущая без RPC-трафика), штатный рычаг —
`experimental_retainWorker()` из контекста живого вызова: держать lease, пока
подписка открыта, отпустить при закрытии. Сегодня такой поверхности нет.

## Последствия

- Плагин не добавляет служебного трафика ради борьбы с reap'ом; гигиена простоя
  host-daemon'а работает без исключений (нет keep-alive регрессии).
- Длинные turn'ы безопасны конструктивно на проверенной версии bb (0.42.1).
- Открытая панель может увидеть устаревшие данные, пока host worker среплен;
  это документированное поведение панелей, а не дефект доставки turn'ов.
- Idle-механика host-daemon'а может поменяться (таймеры, пороги, пути остановки)
  — при апгрейде bb перепроверить `scheduleWorkerIdle`, сессионный
  `reapIdleProviderSessions` и пути остановки bridge-процессов
  (`releaseIdleProviderProcess`, `retireStaleBridgeProcesses`).

## Considered Options

- Держать `experimental_retainWorker()`-lease на всё время open turn'а — отклонено:
  lease доступен только host-вызовам, а turn'ы живут в bridge worker'е, у которого
  таймера нет; lease в host worker'е на время turn'а ничего не защищает и маскирует
  гигиену простоя.
- Keep-alive RPC из bridge worker'а «чтобы был трафик» — отклонено: bridge worker'у
  нечего сбрасывать (таймер не про него), а служебный шум — регрессия гигиены.
- Upstream-репорт в bb — не требуется: механизм влияния на reap (`retainWorker`,
  busy-state) в bb есть, и владельцу turn'а он не нужен.
