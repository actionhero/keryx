import type { Theme } from "vitepress";
import DefaultTheme from "vitepress/theme";
import Changelog from "./Changelog.vue";
import Layout from "./Layout.vue";
import "./custom.css";

export default {
  extends: DefaultTheme,
  Layout,
  enhanceApp({ app }) {
    app.component("Changelog", Changelog);
  },
} satisfies Theme;
