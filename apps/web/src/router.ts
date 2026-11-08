import { createRouter, createWebHistory } from "vue-router";
import Home from "./views/Home.vue";
import Projects from "./views/Projects.vue";
import Account from "./views/Account.vue";
import Sample from "./views/Sample.vue";
import Terms from "./views/Terms.vue";
import Project from "./views/Project.vue";
import Story from "./views/Story.vue";
import Invite from "./views/Invite.vue";
import NotFound from "./views/NotFound.vue";
import Recording from "./views/Recording.vue";
export const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: "/projects/:projectId/production",
      component: () => import("./views/Production.vue"),
      meta: { title: "制作与物流", private: true },
    },
    {
      path: "/projects/:projectId/record",
      component: Recording,
      meta: { title: "记录回忆", private: true },
    },
    { path: "/", component: Home, meta: { title: "岁月成书" } },
    {
      path: "/projects",
      component: Projects,
      meta: { title: "我的项目", private: true },
    },
    {
      path: "/projects/:projectId",
      component: Project,
      meta: { title: "我的故事", private: true },
    },
    {
      path: "/projects/:projectId/stories/:storyId",
      component: Story,
      meta: { title: "故事阅读", private: true },
    },
    { path: "/invite/:token", component: Invite, meta: { title: "项目邀请" } },
    {
      path: "/purchase",
      component: () => import("./views/Purchase.vue"),
      meta: { title: "新购一本书", private: true },
    },
    {
      path: "/purchase/return/:orderId",
      component: () => import("./views/PurchaseReturn.vue"),
      meta: { title: "付款确认", private: true },
    },
    { path: "/account", component: Account, meta: { title: "我的" } },
    { path: "/sample", component: Sample, meta: { title: "公开样书" } },
    { path: "/terms", component: Terms, meta: { title: "使用条款" } },
    {
      path: "/:pathMatch(.*)*",
      component: NotFound,
      meta: { title: "页面未找到" },
    },
  ],
  scrollBehavior: (_to, _from, saved) => saved ?? { top: 0 },
});
router.afterEach((to) => {
  document.title = `${String(to.meta.title)} · 时光故事`;
});
