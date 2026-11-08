<script setup lang="ts">
import { RouterLink } from "vue-router";
</script>
<template>
  <section class="page-heading">
    <p class="eyebrow">公开样书 · 示例内容</p>
    <h1>把平凡的日子，写成一本书。</h1>
    <p class="muted">以下为独立创作的样书节选，不来自用户私人项目。</p>
  </section>
  <article class="sample-book">
    <div class="sample-cover">
      <p>时光故事 · 岁月成书</p>
      <h2>妈妈的一生</h2>
      <span class="cover-line" />
      <p>那些平凡日子里，闪着光的时刻。</p>
      <img src="/images/family.jpg" alt="封面照片效果示意" /><small
        >妈妈的讲述 · 家人的珍藏</small
      >
    </div>
    <div class="sample-story">
      <p class="eyebrow">第一章 · 那些小时候的事</p>
      <h2>院子里的那棵枣树</h2>
      <p>
        小时候，家门口有一个小院子。院子不大，门边却长着一棵枣树。每年春天，看见细小的绿叶从枝头冒出来，我们就开始盼秋天。
      </p>
      <p>
        那时候没有多少零食。枣子刚有一点红，我们就忍不住去看。母亲总说，再等两天，等它甜了再摘。可我们哪里等得住，偷偷尝一颗，酸得眯起眼睛，转头又笑起来。
      </p>
      <p>
        现在回头想，记住的也不只是枣子的味道。是放学回家时院门敞着，是灶房里飘出的饭香，是有人知道我们一定会回来。
      </p>
      <p class="sample-caption">示例故事，展示文字整理与成书阅读效果。</p>
    </div>
  </article>
  <div class="reading-actions">
    <RouterLink class="button secondary" to="/">返回首页</RouterLink>
  </div>
</template>
