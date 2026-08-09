# MWI Market History

自动归档 Milky Way Idle 官方市场数据为按物品拆分的历史记录。

## 工作原理

- [sync-official-market.mjs](sync-official-market.mjs) 下载
  `https://www.milkywayidle.com/game_data/marketplace.json`。
- 按物品拆分的历史数据存放在 `data/items/<itemHrid>__<variant>.json`。
- `data/manifest.json` 索引所有已归档的物品变体。

仓库只归档按物品拆分后的历史数据，不保存每次拉取的原始快照文件。

GitHub Actions 每 30 分钟自动同步一次，并把新增数据提交回仓库。也可以在
Actions 页面手动触发。

## 开源协议

本项目使用 [MIT License](LICENSE)。

## 手动同步

```bash
node sync-official-market.mjs
```

可以通过 `MWI_OFFICIAL_MARKET_URL` 环境变量或 `--source-url` 参数覆盖市场数据地址。
归档固定保留最近 60 天的小时级采样点；更早的完整 UTC 日期按每天一个点聚合。
截止日期所在的 UTC 日会完整保留小时级数据，避免在不同同步时间重复聚合同一天。
