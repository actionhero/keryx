import type { Theme } from "vitepress";
import DefaultTheme from "vitepress/theme";
import CopyOrDownloadAsMarkdownButtons from "vitepress-plugin-llms/vitepress-components/CopyOrDownloadAsMarkdownButtons.vue";
import Changelog from "./Changelog.vue";
import Layout from "./Layout.vue";
import NotFound from "./NotFound.vue";
import "./custom.css";

export default {
  extends: DefaultTheme,
  Layout,
  NotFound,
  enhanceApp({ app }) {
    app.component("Changelog", Changelog);
    app.component(
      "CopyOrDownloadAsMarkdownButtons",
      CopyOrDownloadAsMarkdownButtons,
    );
  },
} satisfies Theme;
