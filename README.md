# Black Frame Detector

Black Frame Detector 是一个用于检测视频中“黑帧”（全黑或接近全黑帧）的 VS Code 扩展，方便用户快速定位并切割出有问题的片段以便处理或删除。

## 特性

- 自动扫描视频文件并识别黑帧的时间点
- 在侧边栏展示检测任务与切点（Tasks 视图）
- 在切点处生成短时预览（WebP 动画）以便快速确认
- 支持将检测结果导出或在 Finder 中定位原始文件

## 安装

从 VS Code Marketplace 安装 `Black Frame Detector`，或在开发模式下从源码运行并使用本地打包结果。

## 使用方法

1. 在侧栏打开 `Black Frame Detector` 视图
2. 创建新的检测任务并选择视频目录
3. 运行检测，等待任务完成后在列表查看切点和预览
4. 通过命令面板运行“Reveal in Finder”或导出结果

## 配置项

插件提供若干设置（在 Settings 中搜索 `blackFrameDetector`）：

- `blackFrameDetector.defaultDirectory`：默认存储目录
- `blackFrameDetector.previewDuration`：预览动画时长（秒）
- `blackFrameDetector.minSliceDuration`：最短切片时长（秒），过短的切点会被忽略

## 贡献与许可

欢迎提交 issue 或 PR。请参阅仓库中的贡献指南。

---

如需更多信息或演示截图，请查看项目页面或在 issue 中询问。

感谢使用！
