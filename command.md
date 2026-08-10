# HDS Interlude 管理员指令

本文档说明 HDS Interlude 当前提供的 Koishi 指令。指令默认只在私聊中使用，并且会经过 OneBot/NapCat 白名单检查。

## 权限模型

管理员权限由 `sharedStory.managerAccounts` 控制：

- 配置为空：所有已通过 `onebot.userAccounts` 白名单检查的账号都可以执行管理指令。
- 配置不为空：只有列表中的 QQ 号可以执行管理员指令。
- 未通过白名单检查的账号不能创建故事、读取上下文或执行管理指令。
- 查询指令不会写入剧本；`interlude.script.note`、`interlude.memory.add` 等人工修正指令会留下可审计记录。建议保持 `runtime.ignoreCommandMessages=true`。

机器人账号和用户账号必须分别配置：

```yaml
onebot:
  botAccounts:
    - qq: '机器人QQ号'
      enabled: true
  userAccounts:
    - qq: '管理员QQ号'
      label: '管理员'
      personId: 'admin'
      relationship: '主角信任的管理员'
      enabled: true

sharedStory:
  managerAccounts:
    - '管理员QQ号'
```

## 指令总览

| 指令 | 权限 | 用途 |
| --- | --- | --- |
| `interlude.init [主角名]` | 白名单用户 | 创建共享主剧本，或将当前账号加入已有主剧本 |
| `interlude.status` | 白名单用户 | 查看故事状态和运行游标 |
| `interlude.setup <JSON>` | 管理员 | 修改当前故事的基础设定（Canon） |
| `interlude.pause` | 管理员 | 暂停自动推进、延迟处理和主动处理 |
| `interlude.resume` | 管理员 | 恢复自动处理 |
| `interlude.advance` | 管理员 | 立即将剧本补写到当前真实时间 |
| `interlude.timeline [条数]` | 白名单用户 | 查看最近原始剧本条目 |
| `interlude.memory [条数]` | 白名单用户 | 查看长期事实记忆 |
| `interlude.context` | 白名单用户 | 查看当前场景、剧情弧线、关系状态和召回事实 |
| `interlude.compact` | 管理员 | 立即执行一次记忆压缩 |
| `interlude.script [条数]` | 管理员 | 查看跨参与者的原始剧本条目 |
| `interlude.script.note <内容>` | 管理员 | 写入带来源标记的人工剧本注记 |
| `interlude.memory.facts [条数]` | 管理员 | 列出长期事实及其编号 |
| `interlude.memory.add <范围> <内容>` | 管理员 | 人工添加高置信度长期事实 |
| `interlude.memory.forget <编号>` | 管理员 | 将长期事实标记为失效，不物理删除 |
| `interlude.memory.intents [条数]` | 管理员 | 查看延迟回复和后续联系计划 |
| `interlude.memory.cancel <编号>` | 管理员 | 取消一条等待中的意图 |
| `interlude.memory.patches [条数]` | 管理员 | 查看人物、关系和世界设定的演化提案 |
| `interlude.memory.reject <编号>` | 管理员 | 拒绝尚未应用的演化提案 |
| `interlude.database.clear <确认口令>` | 管理员 | 清空 HDSI 自有 SQLite 表；不会删除 Koishi 或其它插件数据 |
| `interlude.purge.all <确认口令>` | 管理员 | 彻底重置所有平台的剧本、记忆与 Canon，只保留一部空白主剧本 |
| `interlude.purge.platform <平台> <确认口令>` | 管理员 | 清空并归档指定平台的所有故事，例如 sandbox 或 onebot |
| `interlude.purge.range <开始> <结束> <确认口令>` | 管理员 | 删除时间范围内的剧本与关联记忆 |

## 详细用法

### `interlude.init [主角名]`

创建故事或加入已有故事。

```text
interlude.init 林知遥
```

如果当前机器人账号已经存在共享主剧本，指令不会创建第二个剧本，而是把当前用户作为新的参与者加入。

### `interlude.status`

返回：

- 主角名称
- 参与者数量
- 故事状态（`active` / `paused`）
- 剧本游标 `cursorAt`
- 当前模型模式
- 是否允许主动可见消息

### `interlude.setup <JSON>`

合并修改当前故事的基础设定。参数必须是一个 JSON 对象，不要使用 Markdown 代码块。

```text
interlude.setup {"world":"2026年上海的现实生活","style":"克制、具体、现实主义日常叙事"}
```

可修改字段包括：

```json
{
  "character": {
    "name": "林知遥",
    "profile": "夜班花店店员，作息不规律，习惯用简短语句说话"
  },
  "relationship": "大学旧友，重新恢复联系",
  "world": "当代上海，现实世界，不存在超自然设定",
  "supportingCast": "周宁：主角同事，关系普通",
  "location": "上海静安区",
  "style": "现实主义日常叙事，情绪克制，关系变化缓慢"
}
```

此指令修改的是 Canon，不会删除原始剧本、长期事实或关系分支。若只想改变某个 QQ 对应的人物资料，应修改 Console 中的 `onebot.userAccounts`。

### `interlude.pause` / `interlude.resume`

暂停或恢复当前主剧本的自动处理。

- `pause`：不删除历史记录；暂停自动生活推进、到期意图处理和主动消息。
- `resume`：恢复后台调度。恢复后系统会根据真实时间重新判断是否需要补写。

```text
interlude.pause
interlude.resume
```

### `interlude.advance`

立即补写从 `cursorAt` 到当前真实时间之间已经发生的生活。

```text
interlude.advance
```

该指令可能调用一次主叙事模型，并可能投递模型判断为“当前已经发生”的可见消息。它不会预写未来事件。

### `interlude.timeline [条数]`

查看最近原始剧本条目，默认 10 条，最多显示 30 条。

```text
interlude.timeline 20
```

在多人共享主剧本中，默认优先显示当前账号相关的条目，避免一次输出其他参与者的全部私聊内容。

### `interlude.memory [条数]`

查看主模型或压缩模型提取的长期事实，默认 10 条，最多 30 条。

```text
interlude.memory 15
```

显示内容包含事实范围、重要度和正文。Embedding 只用于检索排序，不会把向量发送给主叙事模型。

### `interlude.context`

查看当前上下文摘要，包括：

- 活动场景引子与摘要
- 当前剧情弧线
- 当前账号的关系状态
- 主角的演化覆写
- 与当前账号相关的长期事实

```text
interlude.context
```

### `interlude.compact`

立即请求一次后台记忆压缩。

```text
interlude.compact
```

压缩模型会整理已完成场景、长期事实和状态变化提案。若当前剧本尚未达到整理阈值，指令会返回“当前还没有达到需要整理的剧本量”。压缩失败不会回滚主剧本，也不会阻塞正常聊天。

## 剧本人工管理

### `interlude.script [条数]`

查看整个共享主剧本的原始条目，默认 20 条，最多 50 条。与 `interlude.timeline` 不同，它不会按当前参与者过滤，因此仅管理员可用。

```text
interlude.script 30
```

每条记录包含数据库编号、发生时间、行为主体、条目类型、参与者标识和正文。编号可用于审计，但当前版本不提供物理删除原始条目的命令，避免误删无法恢复的历史。

### `interlude.script.note <内容>`

向剧本追加人工事实或导演注记。系统会将它标记为 `admin-note` 和“管理员注记”，不会伪装为主模型或用户说过的话；后续压缩会读到这条记录。

```text
interlude.script.note 主角今晚临时换班，直到凌晨前都在花店。
```

适合补充刚刚发生但模型未写到的事件。若修改的是长期稳定事实，优先使用 `interlude.memory.add`。

## 长期记忆管理

### `interlude.memory.facts [条数]`

列出当前有效的长期事实。每条都有 `#编号`、范围、重要度、置信度和未解决标志。

```text
interlude.memory.facts 30
```

### `interlude.memory.add <范围> <内容>`

人工写入一条高置信度（`1.0`）长期事实。允许的范围为：

- `character`：主角稳定事实
- `world`：世界或环境事实
- `relationship`：关系事实
- `event`：长期影响事件
- `promise`：承诺、约定或待办

```text
interlude.memory.add promise 主角答应在周三晚些时候告诉小林面试结果。
```

### `interlude.memory.forget <编号>`

将事实标记为 `superseded`，使其不再进入主模型上下文，但保留数据库记录以供审计。先用 `interlude.memory.facts` 获取编号。

```text
interlude.memory.forget 42
```

### `interlude.memory.intents [条数]` / `interlude.memory.cancel <编号>`

查看或取消等待中的延迟回复、主动联系和后续计划。取消操作只影响尚未执行的意图，不会撤回已经发送的消息。

```text
interlude.memory.intents 20
interlude.memory.cancel 15
```

### `interlude.memory.patches [条数]` / `interlude.memory.reject <编号>`

查看压缩器对人物、关系和世界状态提出的演化提案。已应用、待审核和被拒绝的提案都会显示状态；`reject` 只接受 `proposed` 状态的提案。

```text
interlude.memory.patches 20
interlude.memory.reject 8
```

## 删除剧本和记忆

以下指令是不可逆的数据清理操作，仅允许管理员使用，并且要求完整确认口令。系统会先尝试物理删除；如果 SQLite 文件被占用导致删除失败，会自动改用逻辑删除并清空正文，保证内容不再进入剧本上下文。执行前请先用 `interlude.script`、`interlude.memory.facts` 和 `interlude.context` 导出或截图需要保留的内容。

### `interlude.database.clear <确认口令>`

清空插件自己的 SQLite 数据表（剧本、参与者、记忆、事实、意图、场景、剧情弧线和状态提案）。不会删除 Koishi 用户、频道或其它插件的数据。确认口令固定为：`确认清空HDSI数据库`。

```text
interlude.database.clear 确认清空HDSI数据库
```

### `interlude.purge.all <确认口令>`

删除所有平台的剧本与派生数据，并仅保留当前故事作为空白的全局主剧本：

- 原始剧本条目
- 场景摘要和剧情弧线
- 长期事实与普通记忆
- 等待中的意图/延迟回复计划
- 状态演化提案

会按当前 Console 的 `storyDefaults` 重建主角、世界、文风与默认关系；白名单行中的用户资料和关系也会重新写入参与者档案，并清空关系演化、未读数和待回复数。白名单账号与数据库表结构不会删除。执行后会创建新的空白活动场景和剧情弧线。

```text
interlude.purge.all 确认删除全部剧本和记忆
```

### `interlude.purge.platform <平台> <确认口令>`

只清理并归档某一个平台的所有 HDSI 故事，不影响其它平台。常用平台名为 `sandbox` 和 `onebot`；OneBot 的传输别名会一并匹配。确认口令固定为：`确认删除平台剧本和记忆`。

```text
interlude.purge.platform sandbox 确认删除平台剧本和记忆
```

### `interlude.purge.range <开始> <结束> <确认口令>`

删除指定时间范围内的原始剧本，并删除创建时间、更新时间或来源条目落在该范围内的关联记忆、事实、意图和状态提案。与时间范围重叠的场景摘要也会删除；未重叠的历史数据保留。

时间必须使用可解析的 ISO-8601 格式，建议明确写出时区：

```text
interlude.purge.range 2026-08-01T00:00:00+08:00 2026-08-02T00:00:00+08:00 确认删除时间段剧本和记忆
```

范围删除不会回退故事的真实时间游标，因此后续剧情不会被重新预写；它只清理指定时间段的持久化记录。SQLite 无法物理删除时，会对匹配记录执行逻辑删除和正文清空。

## 推荐的管理员操作顺序

1. 在 Console 中配置 `model.providers`、`storyDefaults` 和 OneBot 白名单。
2. 将管理员 QQ 加入 `sharedStory.managerAccounts`。
3. 发送 `interlude.init 主角名字` 创建共享主剧本。
4. 使用 `interlude.setup` 补充或修正 Canon。
5. 用 `interlude.status` 确认故事状态和模型模式。
6. 用普通私聊测试主模型写作、沉默、延迟回复和多账号关系。
7. 用 `interlude.script`、`interlude.memory.facts`、`interlude.memory.intents` 和 `interlude.memory.patches` 审计当前状态。
8. 需要人工修正时，优先写 `interlude.script.note` 或 `interlude.memory.add`；错误事实用 `interlude.memory.forget` 标记失效。
9. 需要立即测试自动生活或记忆系统时，分别使用 `interlude.advance` 和 `interlude.compact`。

## 故障排查

| 现象 | 检查项 |
| --- | --- |
| 提示没有管理权限 | 当前 QQ 是否在 `onebot.userAccounts`，以及是否在 `sharedStory.managerAccounts`。 |
| 提示没有故事 | 先执行 `interlude.init`，或开启 `runtime.autoCreate`。 |
| 指令被角色当作聊天 | 将 `runtime.ignoreCommandMessages` 设置为 `true`。 |
| `interlude.advance` 没有消息 | 这表示模型补写了生活但没有判断出当前应发送可见消息，并非执行失败。 |
| `interlude.compact` 没有整理内容 | 当前未压缩条目或字符数未达到 `memory.sceneEntryThreshold` / `sceneCharacterThreshold`。 |
| 日志中看不到正常运行信息 | 将 `logging.level` 设为 `info`；排查 API 时临时使用 `debug`，完成后恢复。 |
