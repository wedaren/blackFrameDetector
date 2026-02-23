# Black Frame Detector (黑场切割助手) 需求文档

## 1. 项目目标
提供极简的视频黑场检测与切割工具，核心交互路径为：“选视频 -> 调切点 -> 拿结果”。

## 2. 核心功能

### 2.1 文件与状态管理 (File System Persistence)
*   **平铺目录结构**：用户配置统一的**默认输出目录 (Default Directory)**。
*   **按任务隔离**：每个源视频生成独立的 `[视频名]_[Hash]` 文件夹。
*   **内容聚合**：每个任务文件夹内包含 `task.json` (切点配置)、预览动图缓存、以及 `splits/` (最终输出切片)。
*   **自动清理**：在操作系统中删除该任务文件夹，VS Code TreeView 会自动移除该任务节点。

### 2.2 工作流
1.  **添加**：点击 TreeView 顶部的 `+` 选择本地视频。
2.  **自动检测**：后台静默执行 FFmpeg 黑场扫描，TreeView 节点显式 `loading~spin` 动画，无弹窗打扰。
3.  **调整**：检测完成后，自动打开全屏 Webview 切点编辑器。
4.  **输出**：在 Webview 确认切点并点击“确认并切割”，后台静默执行切割，完成后输出至任务目录下的 `splits/` 中。

### 2.3 TreeView 侧边栏
*   **状态展示**：任务节点以图标和 Tooltip 反映不同状态 (检测中、待确认、已切割)。
*   **快速访问**：单击未完成的视频节点打开 Webview 面板；单击已生成的切片视频直接在系统 Finder/资源管理器 中高亮定位。
*   **右键菜单**：提供 `Reveal in OS` (定位文件)、`Manage Cut Points` (管理切点) 和 `Delete Task` (清理缓存并删除记录)。

### 2.4 Webview 截断点编辑器
*   **双轴微调**：提供范围滑块，支持拖拽和输入框调整。
*   **动态动图预览**：悬停时播放截断点前后的连贯动图 (WebP)，时长由 `blackFrameDetector.previewDuration` 设置。
*   **实时刷新**：滑块或数值任何改变自动触发后台截取新静态预览图局部刷新。
*   **辅助操作**：支持 `Reset to Default` 恢复初始切点，以及新增、删除自定义切点。
*   **智能过滤**：通过 `blackFrameDetector.minSliceDuration` (默认 30s) 参数自动忽略过短的杂乱切片。

## 3. 技术要求
*   依赖全局 `ffmpeg` 环境。
*   UI 遵循 VS Code Webview UI Toolkit 规范。
*   后台命令执行静默化，进度反馈仅依赖 TreeView 状态更新。
