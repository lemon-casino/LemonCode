// ui 包按 NodeNext 解析且未引入 vite/client 类型；controls 适配层按 Mantine
// 官方方式导入按组件 CSS 入口（@mantine/core/styles/Slider.css），这里为其
// 提供最小模块声明，保证 `pnpm typecheck` 可解析。运行时样式由 Vite 处理。
declare module "*.css";
