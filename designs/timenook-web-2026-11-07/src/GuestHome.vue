<script setup lang="ts">
import Icon from "./Icon.vue";
defineProps<{ signedIn: boolean; nickname: string }>();
defineEmits<{ start: []; login: []; sample: []; terms: [] }>();
</script>

<template>
  <section
    v-if="signedIn"
    class="welcome-empty panel"
    data-screen-label="已登录 · 暂无项目"
  >
    <span class="welcome-icon"><Icon name="sprout" :size="24" /></span>
    <div>
      <p class="eyebrow">{{ nickname }}，你好</p>
      <h1>第一本故事书，从这里开始。</h1>
      <p>你还没有项目。为重要的人新建一本书，或从家人分享的邀请链接加入。</p>
      <button class="button welcome-start" @click="$emit('start')">
        <Icon name="plus" :size="16" />开始第一本故事书
      </button>
    </div>
  </section>
  <section
    class="guest-hero"
    :data-screen-label="
      signedIn ? '暂无项目首页 · 产品介绍' : '未登录首页 · 产品介绍'
    "
  >
    <div class="guest-hero-copy">
      <span class="guest-kicker"
        ><Icon name="audio-lines" :size="17" />用声音，珍藏一生</span
      >
      <h1 v-if="!signedIn">
        有些故事，<br />只有<span>他们</span>能讲。<br />有些时光，值得成书。
      </h1>
      <h2 v-else>从一句“那时候”，<br />到一本人生故事。</h2>
      <p class="guest-description">
        听一段往事，留一段原声。<br />把父母与家人的人生，写成可以捧在手里的书。
      </p>
      <div class="guest-primary-actions">
        <button class="button" @click="$emit('start')">
          <Icon name="plus" :size="17" />¥999 · 开始为 TA 记录</button
        ><button class="button ghost" @click="$emit('sample')">
          先看看样书<Icon name="arrow-up-right" :size="16" />
        </button>
      </div>
      <p v-if="!signedIn" class="guest-login-hint">
        已经有项目？<button class="text-button" @click="$emit('login')">
          登录后继续<Icon name="arrow-right" :size="14" />
        </button>
      </p>
      <p v-else class="guest-member-hint">
        <Icon
          name="lock-keyhole"
          :size="14"
        />登录已完成，新建项目前不会发起支付。
      </p>
    </div>
    <figure class="guest-family-photo">
      <img
        src="assets/family.jpg"
        alt="母女相伴，翻阅妈妈的人生故事书，效果示意"
      />
      <figcaption>
        <span>留住故事，也留住熟悉的声音。</span><small>效果示意</small>
      </figcaption>
    </figure>
  </section>

  <section class="guest-steps" aria-label="如何把故事写成书">
    <article>
      <span class="guest-step-number">01</span>
      <div>
        <h2>像聊天一样，慢慢说</h2>
        <p>从一个话题、一张老照片开始，讲多久、讲什么，都由你决定。</p>
      </div>
    </article>
    <article>
      <span class="guest-step-number">02</span>
      <div>
        <h2>把回忆，整理成故事</h2>
        <p>讲述整理为文字，和家人一起补充、编辑，保留自己的表达。</p>
      </div>
    </article>
    <article>
      <span class="guest-step-number">03</span>
      <div>
        <h2>写成一本，值得珍藏的书</h2>
        <p>故事、照片与原声一起留下。书稿准备好了，再安排印刷。</p>
      </div>
    </article>
  </section>

  <div class="guest-details-grid">
    <section class="guest-sample panel">
      <img src="assets/book.jpg" alt="精装人生故事书装帧效果示意" />
      <div>
        <p class="eyebrow">先翻开一段故事</p>
        <h2>一段平凡的往事，<br />也能成为书里的一页。</h2>
        <p>看看讲述如何被留在纸上。<br />样书是示例内容，无需登录即可阅读。</p>
        <button class="text-button" @click="$emit('sample')">
          翻阅样书<Icon name="arrow-right" :size="16" />
        </button>
      </div>
    </section>
    <section class="guest-package panel">
      <div class="section-heading">
        <span class="eyebrow">岁月成书套餐</span><Icon name="gift" :size="21" />
      </div>
      <h2>送给重要的人，<br />一份关于一生的礼物。</h2>
      <p class="guest-price">
        <strong><small>¥</small>999</strong><span>一个项目 · 首本一本</span>
      </p>
      <ul>
        <li><Icon name="check" :size="15" />语音讲述，整理与编辑人生故事</li>
        <li><Icon name="check" :size="15" />故事、照片与原声，一起珍藏</li>
        <li><Icon name="check" :size="15" />专属书稿与一本精装人生书</li>
      </ul>
      <button class="button full-width" @click="$emit('start')">
        开始一本故事书<Icon name="arrow-right" :size="16" />
      </button>
      <p class="package-terms">
        具体服务范围以<button @click="$emit('terms')">《使用条款》</button>为准
      </p>
    </section>
  </div>
  <section class="guest-faq">
    <h2>开始之前，你可能想知道</h2>
    <details>
      <summary>
        不会写作，也可以做一本书吗？<Icon name="plus" :size="17" />
      </summary>
      <p>
        可以。像平常聊天一样讲述即可，录音会被整理为可阅读的故事。你和家人也可以继续补充或修改。
      </p>
    </details>
    <details>
      <summary>需要一次把一生都讲完吗？<Icon name="plus" :size="17" /></summary>
      <p>不需要。每次说一小段，随时回来继续，慢慢把故事补完整。</p>
    </details>
    <details>
      <summary>家人可以一起参与吗？<Icon name="plus" :size="17" /></summary>
      <p>
        可以。接受邀请后，家人作为项目成员一起讲述、编辑故事与整理书稿。项目内容只对有权访问的成员开放。
      </p>
    </details>
  </section>
  <footer class="page-footer">
    <Icon name="lock-keyhole" :size="14" /><span
      >故事与原声，仅对项目成员可见</span
    ><button class="public-terms-link" @click="$emit('terms')">使用条款</button>
  </footer>
</template>
