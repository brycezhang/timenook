<script setup lang="ts">
import { RouterLink } from "vue-router";
</script>
<template>
  <section class="empty-state panel">
    <p class="eyebrow">404</p>
    <h1>这一页暂时找不到了。</h1>
    <p>链接可能有误，回到首页继续看看。</p>
    <RouterLink class="button" to="/">返回首页</RouterLink>
  </section>
</template>
