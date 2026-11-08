<script setup lang="ts">
import { RouterLink } from "vue-router";
import Icon from "../components/Icon.vue";
import { auth } from "../session";
defineEmits<{ login: [] }>();
</script>
<template>
  <section class="hero">
    <div class="hero-copy">
      <span class="kicker"><Icon name="mic" :size="16" />用声音，珍藏一生</span>
      <h1>
        有些故事，<br />只有<span>他们</span>能讲。<br />有些时光，值得成书。
      </h1>
      <p>
        听一段往事，留一段原声。<br />把父母与家人的人生，写成可以捧在手里的书。
      </p>
      <div class="hero-actions">
        <RouterLink v-if="auth.account.value" class="button" to="/projects"
          >继续我的故事<Icon name="arrow" :size="17" /></RouterLink
        ><button v-else class="button" @click="$emit('login')">
          登录，继续记录<Icon name="arrow" :size="17" /></button
        ><RouterLink class="button secondary" to="/sample"
          >先看看样书</RouterLink
        >
      </div>
      <p class="hero-note">
        <Icon name="lock" :size="13" />同一手机号，继续小程序中的项目
      </p>
    </div>
    <figure class="family-photo">
      <img
        src="/images/family.jpg"
        alt="母女相伴，翻阅人生故事书的效果示意"
        fetchpriority="high"
      />
      <figcaption>
        留住故事，也留住熟悉的声音。<small>效果示意</small>
      </figcaption>
    </figure>
  </section>
  <section class="steps" aria-label="如何把故事写成书">
    <article>
      <span>01</span>
      <div>
        <h2>像聊天一样，慢慢说</h2>
        <p>从一个话题、一张老照片开始，讲什么，由你决定。</p>
      </div>
    </article>
    <article>
      <span>02</span>
      <div>
        <h2>把回忆，整理成故事</h2>
        <p>讲述整理为文字，和家人补充、编辑，保留自己的表达。</p>
      </div>
    </article>
    <article>
      <span>03</span>
      <div>
        <h2>写成一本，值得珍藏的书</h2>
        <p>把故事、照片和原声留下，成书后再安排印刷。</p>
      </div>
    </article>
  </section>
  <div class="home-details">
    <section class="sample-card panel">
      <img src="/images/book.jpg" alt="人生故事书装帧效果示意" loading="lazy" />
      <div>
        <p class="eyebrow">先翻开一段故事</p>
        <h2>一段平凡的往事，<br />也能成为书里的一页。</h2>
        <p class="muted">
          看看讲述如何被留在纸上。<br />公开样书，无需登录即可阅读。
        </p>
        <RouterLink class="text-button" to="/sample"
          >翻阅样书<Icon name="arrow" :size="16"
        /></RouterLink>
      </div>
    </section>
    <section class="package-card panel">
      <p class="eyebrow">岁月成书套餐</p>
      <h2>送给重要的人，<br />一份关于一生的礼物。</h2>
      <p class="package-price">
        <span>¥</span>999<small>一个项目 · 首本一本</small>
      </p>
      <ul>
        <li><Icon name="check" :size="16" />语音讲述，整理与编辑人生故事</li>
        <li><Icon name="check" :size="16" />故事、照片与原声，一起珍藏</li>
        <li><Icon name="check" :size="16" />专属书稿与一本人生书</li>
      </ul>
      <RouterLink to="/terms" class="text-button"
        >查看服务约定<Icon name="arrow" :size="16"
      /></RouterLink>
    </section>
  </div>
  <section class="faq">
    <p class="eyebrow">开始之前</p>
    <h2>你可能想知道</h2>
    <details>
      <summary>不会写作，也可以做一本书吗？</summary>
      <p>
        可以。像平常聊天一样讲述即可，讲述会被整理成可阅读的故事。你和家人也可以继续补充和修改。
      </p>
    </details>
    <details>
      <summary>需要一次把一生都讲完吗？</summary>
      <p>不需要。每次说一小段，随时回来继续，慢慢把故事补完整。</p>
    </details>
    <details>
      <summary>家人可以一起参与吗？</summary>
      <p>
        可以。接受项目邀请后，家人作为成员一起记录、编辑故事和整理书稿。内容只对有权访问的成员开放。
      </p>
    </details>
  </section>
  <footer class="page-footer">
    <Icon name="lock" :size="14" />故事与原声，仅对项目成员可见<RouterLink
      to="/terms"
      >使用条款</RouterLink
    >
  </footer>
</template>
