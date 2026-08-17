# HDS Interlude 新手引导

HDS Interlude 是 Koishi 的持续叙事聊天插件。插件使用共享主剧本保存角色状态、关系分支、已发生事件、待处理计划和长期记忆。用户消息会进入当前剧本回合；主模型在同一次请求中补写已过去的时间，并决定是否发送、延迟发送或暂不发送消息。

## 适用场景

- 角色需要保留长期关系、日程、承诺和事件连续性。
- 多个 QQ 账号需要与同一角色共享一个主剧本。
- 需要延迟回复、主动联系、自动推进或提醒计划。
- 需要通过摘要、长期事实和语义检索控制上下文长度。

## 首次配置

1. 在 Koishi Console 启用 `hds-interlude`。
2. 在“模型与服务商”中配置 OpenAI Chat Completions 兼容服务商，并在主叙事模型位置选择一个模型预设。
3. 在“剧本起点”中填写主角资料、默认关系、世界设定、地点、时区和叙事风格。
4. 使用 OneBot/NapCat 时，在 `onebot.botAccounts` 填写机器人 QQ；在 `onebot.userAccounts` 逐项填写允许私聊的测试 QQ、人物资料和初始关系。
5. 保存配置后，在已授权私聊中执行：

```text
interlude.init 主角名字
```

6. 发送一条普通消息，确认模型调用、日志和消息投递正常。

空的私聊用户白名单表示不允许任何 QQ 进入私聊剧本。

## 建议测试顺序

1. 先关闭 `runtime.allowProactiveMessages`、Embedding 和网页浏览，只验证私聊回复。确认角色的日常推进稳定后，再开启主动联系；主动联系由主模型逐次给出意愿值，不使用机械冷却。
2. 在两秒内发送多条短消息，确认它们只产生一次主模型写作回合。
3. 测试延迟回复：用户再次发言后，旧延迟计划应取消并重新判断。
4. 开启 `runtime.autoAdvanceEnabled`，使用 `interlude.advance` 检查自动回合的剧本和消息行为。
5. 将两个 QQ 加入白名单，确认它们共享主剧本且各自保留关系资料。
6. 最后启用记忆压缩、Embedding、群聊和 Puppeteer。

## 常用配置位置

| 配置组 | 用途 |
| --- | --- |
| `model` | 服务商、模型预设、提示词、压缩模型、Embedding 和群聊筛选模型。 |
| `storyDefaults` | 新主剧本的 Canon：主角、世界、默认关系和叙事风格。 |
| `onebot` | 机器人 QQ、私聊白名单、群聊白名单和群聊资料。 |
| `sharedStory` | 多账号关系分支、跨账号消息和管理员权限。 |
| `runtime` | 消息合并、延迟发送、自动推进、休息时段和失败重试。 |
| `memory` | 剧本压缩、事实召回、剧情余波和设定演化。 |
| `browser` | 可选的 Puppeteer 网页观察。 |
| `logging` | 日志级别、信息密度、显示布局和内容预览。 |

## 常用管理指令

- `interlude.status`：查看当前主剧本状态。
- `interlude.context`：查看场景摘要、关系状态和长期事实。
- `interlude.timeline`：查看当前账号相关的近期剧本条目。
- `interlude.memory.intents`：查看延迟回复、提醒、承诺和剧情余波。
- `interlude.pause` / `interlude.resume`：暂停或恢复后台处理。
- `interlude.overlay.status`：查看当前 overlay、待积累提案和压缩快照。
- `interlude.overlay.compact`：只合并/压缩已经应用的 overlay。
- `interlude.overlay.clear character|relationship|world|all`：清理指定类型的设定演化覆盖层；执行后按提示确认，同时会使相关待积累候选失效。

overlay 不会因为一次聊天就改变人格。普通变化需要多个剧本回合和不同日期的证据；近期情绪和关系变化会先留在剧本、关系笔记或剧情余波中。只有稳定变化才会进入长期 overlay。

完整配置说明见 `CONFIGURATION_GUIDE.md`，管理员指令说明见 `command.md`。
