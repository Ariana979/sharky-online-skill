# 越狱·破晓 Daybreak

多人合作 3D 潜行逃脱（three.js + sharky.gg 平台联机）。向经典越狱题材美剧致敬的原创二创：
原创的"风河监狱"与角色代号，复刻标志性逃脱路线——

牢房拆螺栓（同伴挂床单挡狱警视线）→ 墙洞 → 管道夹层 → 双人合力抬起通风重闸进 P.I. 仓库
→ 门禁开关接力（一人按住开关、others 过门后反向卡锁）→ 撬开医务室铁窗（躲夜巡狱医）
→ 沿电缆越过矮墙段（蓝图上的薄弱点，避开探照灯）→ 破晓点名前**所有人**上洗衣房货车。

- 警报累计 3 次 = 全监封锁，行动失败；被发现会被押回所在区域检查点
- 倒计时（破晓）由房间时钟驱动，狱警巡逻/探照灯为全客户端确定性动画，零同步流量
- `E` 制造声响可把狱警引开；`Shift` 潜行缩小被发现半径；`M` 打开纹身蓝图风格地图
- 1–8 人：双人任务在单人时自动降级（门禁延迟关闭），人多时配合是通关效率的关键

## 构建 / 本地联机测试 / 发布

```bash
cd games/daybreak
bun ../../scripts/build.ts --game daybreak.html --title "越狱·破晓 Daybreak" \
    --min-players 1 --max-players 8 --out dist/index.html
bun ../../scripts/playtest-gate.ts --html dist/index.html --two-client   # 双端 seam 验证
bun ../../scripts/dev-serve.ts --html dist/index.html                    # 本地双人 mock 房间
bun ../../scripts/publish.ts --html dist/index.html --title "越狱·破晓 Daybreak" \
    --min-players 1 --max-players 8 --cover-description "..."
```

与任何影视作品无官方关联。
