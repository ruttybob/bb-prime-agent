---
status: accepted
---

# Native provider bridge вместо ACP

prime-agent открывает наружу несколько поверхностей (CLI, RPC, ACP, daemon), и самый очевидный путь в bb — ACP. Мы выбрали native provider-плагин bb (Provider Bridge Protocol → RPC/daemon-протоколы prime-agent): ACP не выражает steer/follow_up-семантику, fork по сообщению, управление субагентами и heartbeats, а prime-специфика в ACP доступна только как пассивные `_meta`-нагрузки — видеть можно, управлять нельзя. Цена решения — зависимость от daemon-поверхности prime-agent, не заявленной как публичный контракт; смягчается адаптером версий и conformance-записями (recorded replay).

## Considered Options

- ACP generic dialect — дёшево, но теряется именно то, ради чего интеграция: управление циклом агента и субагентами.
- ACP + prime `_meta`-dialect — тот же объём работы, что свой bridge, при заметно меньших возможностях.
