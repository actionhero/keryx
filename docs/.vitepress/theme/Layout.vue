<script setup>
import { useData } from "vitepress";
import DefaultTheme from "vitepress/theme";
import CliSnippet from "./CliSnippet.vue";
import GitHubStars from "./GitHubStars.vue";
import HomeContent from "./HomeContent.vue";
import MarkdownLink from "./MarkdownLink.vue";

const { Layout } = DefaultTheme;
const { frontmatter } = useData();
</script>

<template>
  <Layout>
    <template #home-hero-info-after>
      <div class="hero-ctas">
        <CliSnippet />
        <GitHubStars />
      </div>
    </template>
    <template #home-features-after>
      <HomeContent />
    </template>
    <template v-if="frontmatter.layout !== 'home'" #doc-footer-before>
      <MarkdownLink />
    </template>
    <template #layout-bottom>
      <div class="footer-lion">
        <img src="/images/lion-sitting.svg" alt="Keryx lion" />
      </div>
    </template>
  </Layout>
</template>

<style scoped>
.hero-ctas {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 20px;
}

.footer-lion {
  display: flex;
  justify-content: center;
  padding-bottom: 24px;
}
</style>
