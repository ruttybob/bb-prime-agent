---
status: accepted
---

# Bridge говорит по daemon-протоколу напрямую

Bridge — полноправный клиент daemon prime-agent (`create` с `lifecycle: "resident"`, attach со снапшотом, `send_message`, `cancel_rlm_child`), а не обёртка над задокументированным `--mode rpc`, как pi-provider в bb. RPC-child создаёт session lifecycle «client_owned»: daemon убирает такую сессию через 30 с после отключения владельца — это противоречит resident-модели потоков bb (ADR-0001), семантике release=stop и видимости bb-сессий из prime TUI. Субагент-функционал (snapshot.children, steer детям) в RPC-варианте тоже урезан. Цена решения — зависимость от протокола, не заявленного как публичный контракт (schema revision меняется между релизами prime); смягчение — capability-gating по `daemon_hello` (штатный механизм совместимости команд prime) и предупреждение при несовместимости вместо блокировки потоков.

## Considered Options

- RPC-child (паттерн pi-bridge): публично документирован и проверен, но client_owned-сессии умирают, resident-модель невыполнима.
- In-process RPC (`InProcessAgentConnection`): держит сессию в процессе bridge, те же проблемы lifecycle.
