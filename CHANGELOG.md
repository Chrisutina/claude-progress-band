# 更新记录 / Changelog

## 0.3.0 · 2026-10-04

- 5 小时用量达到 85% 后，仅显示额度提示和未完成进度条的红框；移除原来发给 Claude 的收尾、暂停提示。窗口重置后清除提醒，已完成任务不闪烁。
- 新增 `language` 配置，支持中文（默认 `zh`）和英文（`en`），覆盖桌面、终端和悬停文字。
- 共 27 项自动测试通过，包含 85% 临界值、窗口重置、已完成任务以及英文界面检查。

- At 85% five-hour usage, show a visual alert on unfinished bars. Remove the previous instruction asking Claude to wrap up and pause. Clear the alert when the window resets; completed bars do not flash.
- Add the `language` option: Chinese (`zh`, default) or English (`en`) for desktop, terminal and hover text.
- All 27 automated tests pass, including threshold, reset, completed-bar and English UI coverage.

## 0.2.0 · 2026-10-03

- 首次发布：上下文、5 小时及每周用量表，token 桑基图，按会话保存的任务进度条和子代理状态。
- Initial publication: context, five-hour and weekly usage meters, a token Sankey, session-persisted task bars and subagent status.
