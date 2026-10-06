# 更新记录 / Changelog

## 0.5.0 · 2026-10-06

- 出错改成故障带：出错的进度条整条变成暗色条，ERROR 带着青红重影流动，每 2.2 秒撕裂错位一次。取代红色极光停住闪烁。
- 额度提醒：线从 85% 改到 90%，去掉"额度超过阈值"字样和终端里闪烁的同名标签。过线后 5 小时表变成琥珀色 LED 点阵箭头；之后每多用 2%，未完成的进度条变成故障带 6 秒（琥珀色 WARNING，有活干时流得更快，每 4.8 秒轻轻撕裂一次），再恢复原样；平时一切照旧。取代霓虹红极光。
- 故障带铺满整条，滑块之后的部分变淡，第一步就出错也看得见。
- 终端：出错的进度条写满 ERROR，额度提醒那 6 秒里未完成的写满 WARNING，每秒走一格。
- 共 31 项自动测试通过。

- Error: a failed bar becomes a dark glitch band, ERROR streaming in cyan and magenta fringes and tearing every 2.2 s. It replaces the red aurora that froze and blinked.
- Quota alert: the line moves from 85% to 90%, and the "Quota over threshold" pill and its blinking terminal badge are gone. Past the line the 5-hour meter becomes an amber LED dot-matrix marching arrows, and at every 2 more points the unfinished bars become a glitch band for six seconds (an amber WARNING, faster while work runs, tearing gently every 4.8 s), then return to normal; otherwise nothing changes. It replaces the neon red aurora.
- Glitch bands cover the whole track, dimmed past the thumb, so a bar that fails at its first step still shows one.
- Terminal: a failed bar reads ERROR and, during an alert's six seconds, an open bar reads WARNING, stepping a cell a second.
- All 31 automated tests pass.

## 0.4.0 · 2026-10-05

- 进度条和用量表从像素管道换成极光：三层柔光往滑块方向流。干活时流动，子代理越多越快；暂停时半速漂，等输入时呼吸，出错时停住闪烁，完成后慢慢漂。
- 状态图标从三根音柱换成原子：三颗电子绕核转，干活时快，暂停和空闲时慢；等输入时呼吸，出错时电子停下、原子核闪烁，完成时隔一阵弹一下。
- 额度提醒：未完成进度条里的极光变成霓虹红，发光并隔一阵闪一下，取代红色气体像素屏；"额度超过阈值"不变。
- 删除像素管道、红色气体和音柱的代码。
- 共 30 项自动测试通过。

- The bars and usage meters are now aurora instead of a pixel pipe: three layers of soft light flowing toward the thumb. It streams while work runs, faster with more subagents; it drifts at half speed while the work pauses, breathes while waiting, freezes and blinks on an error, and drifts slowly once done.
- The state icons are now atoms instead of three level bars: three electrons circle the nucleus, fast while work runs and slow while it pauses or nothing runs; a wait breathes, an error stops the electrons and blinks the nucleus, and a done atom pops now and then.
- Quota alert: the aurora in unfinished bars turns neon red, glowing and flickering now and then, in place of the red gas pixel grid; the "Quota over threshold" pill is unchanged.
- The pixel pipe, the red gas and the level bars are gone from the code.
- All 30 automated tests pass.

## 0.3.1 · 2026-10-04

- 额度提醒改为：未完成的进度条变成霓虹红像素屏，像素被流向滑块的红色气体点亮，不再闪红框；5 小时表旁的"额度超过阈值"不变。
- 修复：建计划或改计划时直接标成完成的步骤，悬停一直显示"未到达"。现在只要步骤已完成就算到达，没有时刻的显示"完成"；改计划时把进行中的步骤标成完成，会记下完成时刻。
- 发下一个问题时，自动清掉上一个问题已完成的进度条，不用再手动关。
- 修复：桌面版用量那排会随状态文字（工具名）长短在一行、两行之间跳。现在始终一行：状态文字限宽截断，放不下时依次省略 5 小时重置时刻、每周倒计时、5 小时倒计时、token 文字。
- 共 30 项自动测试通过。

- The quota alert now turns every unfinished bar into a neon red pixel grid lit by red gas flowing to its thumb, in place of the flashing red ring; the "Quota over threshold" pill stays.
- Fix: steps sent in already finished, at creation or in a resent plan, showed "not reached" on hover. A checkpoint now counts as reached once its steps are finished and says "done" when its time is unknown; a resent plan that finishes the step in progress stamps it with the time.
- Your next prompt clears the bars the previous one finished, so they no longer need closing by hand.
- Fix: on the desktop the usage row jumped between one and two lines as the activity label (a tool's name) changed length. It now stays on one line: the label is cut to a fixed room, and what does not fit drops in order: the 5-hour reset's clock time, the weekly countdown, the 5-hour countdown, the token words.
- All 30 automated tests pass.

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
