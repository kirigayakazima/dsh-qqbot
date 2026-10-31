# @tencent-connect/dsh-qqbot (DSHA 主权增强分支)

> **定位**: 本仓库是腾讯官方 [`tencent-connect/dsh-qqbot`](https://github.com/tencent-connect/dsh-qqbot) 的 DSHA 主权 Fork 分支（基于 upstream v0.5.5 稳定发布版）。作为 DeepSeek Harness (dsh) 与 QQ 官方开放平台的协议桥梁，支持全双工会话、富媒体与双端自治智能体协同。

---

## 🌟 主权魔改与核心特性

1. **容器原生服务暴露 (Sovereign Service Provision)**：
   - 在网关初始化引导中原生向 Cordis 容器注册 `qqbotSender` 与 `qqbotMediaSender` 服务；
   - 彻底免除外部脆弱的运行时 sed/文本热补丁，让伴随增强插件 [`@dsh/qq-plus`](file:///d:/CodePackage/DSHA/projects/dsh-qq-plus)（双角色断句）与 [`@dsh/rvc`](file:///d:/CodePackage/DSHA/projects/dsh-rvc)（QQ 语音条投递）原生零门槛注入。
2. **拟人化唤醒门控增强 (Dynamic Wake Gate)**：
   - 基于 SDK 原生 `isImplicitMention` 契约，支持小满与阿醒角色唤醒词（`小满`、`妹妹`、`满宝`、`阿醒`、`姐姐`）及斜杠命令静默唤醒，免去每次强制手工 `@bot` 的生硬体验。
3. **上游 v0.5.5 完整加固特性**：
   - **会话 ID 加固**：统一规范化前缀，彻底解决旧版本并发或特定宿主环境下 `findBySessionId` 无法匹配导致“DSHA 有内容但 QQ 未送达”的问题；
   - **流式回复实时通道**：支持 `agent/assistant-stream` 全局流式帧路由与断线重试自愈；
   - **访问控制与文件安全**：强化私聊/群聊访问控制，支持 present 交付物自动送达当前会话。

---

## 🛠️ 构建与部署

### PC 端编译打包并推送到手机端
```bash
# 编译 TypeScript 与打包
pnpm --dir projects/dsh-qqbot run build
uv run python scripts/deploy_to_phone.py --plugin qqbot
```

### 手机容器端一键升级
```bash
sh /sdcard/dshproject/updates/install_or_update.sh
```

---

## 🙏 致谢与声明 (Acknowledgments)

- 衷心感谢腾讯官方及原作者团队 [`tencent-connect/dsh-qqbot`](https://github.com/tencent-connect/dsh-qqbot) 开源的官方优秀驱动。
- 本项目遵循 MIT 许可证进行自主托管与维护。
