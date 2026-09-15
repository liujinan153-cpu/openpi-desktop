---
name: viz
description: Data visualization: in conversations, directly render ECharts interactive charts (bar/line/pie/graph/sankey/timeline, etc.). Whenever the user asks to "draw a chart / visualize / create a chart / show trends / view proportions / plot a relationship graph / create a timeline," or when data in the answer would be more intuitive as a chart, output an echarts code block in the reply, and the interface will automatically render it as an interactive chart.
---

# 可视化（聊天内 ECharts）

界面会把回复里的 ```` ```echarts ```` 代码块**自动渲染成交互图表**（支持悬停 tooltip、图例开关、缩放）。零依赖、即时可见，产物就在对话里。

## 用法

回复中直接输出 echarts 代码块，内容为一个 **ECharts option JSON**（严格 JSON：双引号、无尾逗号、不要注释）：

````markdown
三季度销售额对比如下：

```echarts
{
  "title": { "text": "三季度销售额（万元）" },
  "tooltip": {},
  "xAxis": { "type": "category", "data": ["7月", "8月", "9月"] },
  "yAxis": { "type": "value" },
  "series": [{ "type": "bar", "data": [128, 156, 171] }]
}
```
````

## 何时用哪种图

| 数据形态 | 图表类型 | series.type |
|---|---|---|
| 对比/排名 | 柱状图 | `bar` |
| 趋势/时间序列 | 折线图 | `line` |
| 占比构成 | 饼图/环形图 | `pie` |
| 流量/转化 | 桑基图 | `sankey` |
| 关系/架构 | 关系图 | `graph`（layout: "force" 或 "circular"） |
| 阶段演进 | 时间线 | `timeline` + series |
| 多维分布 | 散点图 | `scatter` |

## 规则（重要）

1. **必须是合法 JSON**——interface 用 JSON.parse 解析，失败会显示为普通代码块。不要写 JS 表达式、函数、注释、尾逗号。
2. **必须有 `series` 字段**，否则视为误触发不渲染。
3. 一次只放**一个图表对象**；多个图表就输出多个 echarts 代码块，每个前面配一句说明。
4. 数据来自文件时，先读文件算好数值，再写进 JSON——不要引用变量名。
5. 配色克制：默认 ECharts 配色即可；深色界面下图表容器是白底卡片，无需适配暗色。
6. **超大数据集**（>2000 点）先降采样再输出，避免卡顿。
7. 复杂仪表盘/多图联动看板：改用写 HTML 文件的方式（文件卡预览），聊天内 echarts 块适合 1-3 个图表的快速展示。
