# HDS Interlude 管理员指令

本文档说明 HDS Interlude 当前提供的 Koishi 指令。指令默认只在私聊中使用，并且会经过 OneBot/NapCat 白名单检查。

## 权限模型

管理员权限由 `sharedStory.managerAccounts` 控制：

- 配置为空：所有已通过 `onebot.userAccounts` 白名单检查的账号都可以执行管理指令。
- 配置不为空：只有列表中的 QQ 号可以执行管理员指令。
- 未通过白名单检查的账号不能创建故事、读取上下文或执行管理指令。
- 管理指令不会写入剧本。建议保持 `runtime.ignoreCommandMessages=true`。

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

## 推荐的管理员操作顺序

1. 在 Console 中配置 `model.providers`、`storyDefaults` 和 OneBot 白名单。
2. 将管理员 QQ 加入 `sharedStory.managerAccounts`。
3. 发送 `interlude.init 主角名字` 创建共享主剧本。
4. 使用 `interlude.setup` 补充或修正 Canon。
5. 用 `interlude.status` 确认故事状态和模型模式。
6. 用普通私聊测试主模型写作、沉默、延迟回复和多账号关系。
7. 用 `interlude.timeline`、`interlude.memory`、`interlude.context` 检查连续性。
8. 需要立即测试自动生活或记忆系统时，分别使用 `interlude.advance` 和 `interlude.compact`。

## 故障排查

| 现象 | 检查项 |
| --- | --- |
| 提示没有管理权限 | 当前 QQ 是否在 `onebot.userAccounts`，以及是否在 `sharedStory.managerAccounts`。 |
| 提示没有故事 | 先执行 `interlude.init`，或开启 `runtime.autoCreate`。 |
| 指令被角色当作聊天 | 将 `runtime.ignoreCommandMessages` 设置为 `true`。 |
| `interlude.advance` 没有消息 | 这表示模型补写了生活但没有判断出当前应发送可见消息，并非执行失败。 |
| `interlude.compact` 没有整理内容 | 当前未压缩条目或字符数未达到 `memory.sceneEntryThreshold` / `sceneCharacterThreshold`。 |
| 日志中看不到正常运行信息 | 将 `logging.level` 设为 `info`；排查 API 时临时使用 `debug`，完成后恢复。 |

