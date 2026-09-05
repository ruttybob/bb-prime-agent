---
status: accepted
---

# Dynamic tools доставляются companion-extension, а не MCP

bb-инструменты (dynamic tools) доставляются в prime-сессию расширением, загруженным
явно через `create.config.extensions` при `config.noExtensions: true` (точный
per-session аналог `-e` + `-ne`); расширение само регистрирует и снимает инструменты
в живой сессии через `pi.registerTool()` / `pi.setActiveTools()`, следя за bb-стороной
изнутри своего процесса. Канал через MCP отклонён: в 0.7.3 `mcpServers` живёт только
в settings.json (не per-session), принимает только HTTP-серверы, а главное — MCP-
интеграции вообще не являются инструментами агента (это Python-скиллы IPython-ядра),
и `replace_acp_mcp_servers` в версии не существует. Цена решения — companion-extension
нужно портировать и поддерживать как часть плагина; смягчение — референс
`examples/extensions/dynamic-tools.ts` в самом prime и живое доказательство канала
(spike `docs/spikes/0001-prime-daemon-protocol.md`: инструмент зарегистрирован,
вызван моделью, результат вернулся в сессию).

## Considered Options

- MCP-мост (кандидат `replace_acp_mcp_servers`) — не существует в 0.7.3; MCP там не
  канал инструментов вовсе.
- Env-var механизм `PI_BB_TOOLS_FILE` (как в некоторых pi-сетапах) — в 0.7.3 отсутствует,
  env в сессии прокидывается только по allowlist `HERDR_*`.
