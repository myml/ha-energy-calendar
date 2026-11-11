按**月历**显示每日用电量和电费，外观接近网上国网 App 的「用电日历」。

数据来自 HA 长期统计，与能源面板数字一致。

```yaml
type: custom:energy-calendar-card
entities:
  - entity: sensor.your_energy_sensor
price: 0.58
```

详见 [README](README.md)。
