<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { RouterLink, RouterView, useRoute, useRouter } from "vue-router";
import { auth, restoreSession } from "./session";
import LoginDialog from "./components/LoginDialog.vue";
import Icon from "./components/Icon.vue";
import Home from "./views/Home.vue";
const route = useRoute(),
  router = useRouter();
const loginVisible = ref(false);
let afterLogin = "/projects";
const signedIn = computed(() => !!auth.account.value);
function login(target = "/projects") {
  afterLogin = target;
  loginVisible.value = true;
}
function navigate(path: string) {
  if (path === "/projects" && !signedIn.value) login(path);
  else void router.push(path);
}
function closeLogin() {
  loginVisible.value = false;
  if (route.meta.private && !signedIn.value) void router.replace("/");
}
async function loggedIn() {
  loginVisible.value = false;
  await router.push(afterLogin);
}
watch([() => route.fullPath, auth.restoring, auth.account], () => {
  if (route.meta.private && !auth.restoring.value && !signedIn.value)
    login(route.fullPath);
});
onMounted(() => {
  void restoreSession();
});
</script>
<template>
  <div class="app-shell">
    <aside class="sidebar">
      <RouterLink class="brand" to="/"
        ><span class="brand-mark"><Icon name="book" :size="25" /></span
        ><span>时光故事<small>岁月成书</small></span></RouterLink
      >
      <p class="sidebar-caption">给时光一个温柔的归处</p>
      <nav aria-label="主导航">
        <button :class="{ active: route.path === '/' }" @click="navigate('/')">
          <Icon name="home" />岁月成书</button
        ><button
          :class="{ active: route.path === '/projects' }"
          @click="navigate('/projects')"
        >
          <Icon name="book" />我的项目</button
        ><button
          :class="{ active: route.path === '/account' }"
          @click="navigate('/account')"
        >
          <Icon name="user" />我的
        </button>
      </nav>
      <div class="sidebar-bottom">
        <div class="privacy-note">
          <Icon name="lock" :size="16" />
          <p>家人的故事，<br />只留给在意的人。</p>
        </div>
        <RouterLink to="/terms">使用条款与隐私说明</RouterLink>
      </div>
    </aside>
    <div class="main-shell">
      <header class="topbar">
        <RouterLink class="mobile-brand" to="/"
          ><Icon name="book" />时光故事</RouterLink
        ><span class="desktop-page-title">{{ route.meta.title }}</span
        ><span
          v-if="auth.restoring.value"
          class="avatar-skeleton skeleton"
          aria-label="正在确认登录状态"
        /><button v-else-if="!signedIn" class="button small" @click="login()">
          登录 / 注册</button
        ><RouterLink v-else class="account-link" to="/account"
          ><span class="avatar">{{
            auth.account.value!.user.nickname?.slice(-2) ?? "我"
          }}</span
          ><span>{{
            auth.account.value!.user.nickname ?? "我的账号"
          }}</span></RouterLink
        >
      </header>
      <main id="main-content" class="page-content">
        <div v-if="auth.restoreError.value" class="notice" role="alert">
          {{ auth.restoreError.value
          }}<button class="text-button" @click="restoreSession">重试</button>
        </div>
        <template v-if="route.meta.private && !signedIn"
          ><section
            v-if="auth.restoring.value"
            class="project-grid"
            aria-busy="true"
            aria-label="正在读取项目"
          >
            <div v-for="i in 3" :key="i" class="project-card skeleton-card">
              <div class="skeleton skeleton-cover" />
              <div class="skeleton skeleton-line" />
            </div>
          </section>
          <Home v-else @login="login()"
        /></template>
        <RouterView v-else v-slot="{ Component }"
          ><component :is="Component" @login="login()"
        /></RouterView>
      </main>
    </div>
    <nav class="bottom-nav" aria-label="手机主导航">
      <button :class="{ active: route.path === '/' }" @click="navigate('/')">
        <Icon name="home" /><span>岁月成书</span></button
      ><button
        :class="{ active: route.path === '/projects' }"
        @click="navigate('/projects')"
      >
        <Icon name="book" /><span>我的项目</span></button
      ><button
        :class="{ active: route.path === '/account' }"
        @click="navigate('/account')"
      >
        <Icon name="user" /><span>我的</span>
      </button>
    </nav>
    <LoginDialog v-if="loginVisible" @close="closeLogin" @success="loggedIn" />
  </div>
</template>
