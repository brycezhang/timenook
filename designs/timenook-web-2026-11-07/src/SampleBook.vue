<script setup lang="ts">
import { ref } from "vue";
import Icon from "./Icon.vue";
import { initialProjects } from "./data";
const index = ref(0);
const samples = initialProjects[0].stories.slice(0, 2);
</script>
<template>
  <div class="sample-caption">
    <span class="badge neutral">样书节选 · 示例内容</span
    ><span>无需登录即可阅读</span>
  </div>
  <div v-if="index === 0" class="sample-cover">
    <img src="assets/book.jpg" alt="妈妈的一生，样书效果示意" />
    <div>
      <p class="eyebrow">妈妈的一生</p>
      <h3>那些平凡的日子，<br />原来一直闪着光。</h3>
      <p>一本书，留下讲过的故事；<br />一段原声，留住熟悉的声音。</p>
    </div>
  </div>
  <article v-else class="sample-reading">
    <span class="eyebrow">{{ samples[index - 1].chapter }}</span>
    <h3>{{ samples[index - 1].title }}</h3>
    <div class="prose">
      <p v-for="paragraph in samples[index - 1].paragraphs" :key="paragraph">
        {{ paragraph }}
      </p>
    </div>
  </article>
  <div class="sample-pagination">
    <button class="button outline" :disabled="index === 0" @click="index--">
      <Icon name="chevron-left" :size="16" />上一页</button
    ><span>{{ index + 1 }} / 3</span
    ><button class="button outline" :disabled="index === 2" @click="index++">
      下一页<Icon name="chevron-right" :size="16" />
    </button>
  </div>
</template>
