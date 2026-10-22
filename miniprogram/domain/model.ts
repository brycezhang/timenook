export type Recipient = "妈妈" | "爸爸";
export interface Recording {
  id: string;
  path: string;
  duration: number;
  question: string;
}
export interface Story {
  id: string;
  title: string;
  body: string;
  chapter: string;
  version: number;
  confirmedVersion: number | null;
  included: boolean;
  photos: string[];
  recordings: Recording[];
  sample: boolean;
}
export interface Address {
  name: string;
  phone: string;
  detail: string;
}
export interface Project {
  id: string;
  recipient: Recipient;
  title: string;
  buyer: string;
  consent: boolean;
  role: "buyer" | "narrator";
  purchased: boolean;
  sample: boolean;
  revision: number;
  contentApproved: number | null;
  layoutApproved: number | null;
  stories: Story[];
  recordings: Recording[];
  address: Address;
  printRevision: number | null;
}
export function createProject(recipient: Recipient): Project {
  return {
    id: `local-${Date.now()}`,
    recipient,
    title: `${recipient}的一生`,
    buyer: "孩子",
    consent: false,
    role: "buyer",
    purchased: true,
    sample: false,
    revision: 1,
    contentApproved: null,
    layoutApproved: null,
    stories: [],
    recordings: [],
    address: { name: "", phone: "", detail: "" },
    printRevision: null,
  };
}
export function touch(p: Project) {
  p.revision += 1;
  p.contentApproved = null;
  p.layoutApproved = null;
  return p;
}
export function editStory(p: Project, id: string, title: string, body: string) {
  const s = p.stories.find((s) => s.id === id);
  if (!s) throw new Error("故事不存在");
  if (s.title === title && s.body === body) return p;
  s.title = title;
  s.body = body;
  s.version += 1;
  s.confirmedVersion = null;
  return touch(p);
}
export function readyToPrint(p: Project) {
  const included = p.stories.filter((s) => s.included);
  return (
    included.length > 0 &&
    included.every((s) => s.confirmedVersion === s.version) &&
    p.contentApproved === p.revision &&
    p.layoutApproved === p.revision
  );
}
export function validAddress(a: Address) {
  return (
    a.name.trim().length > 0 &&
    /^1\d{10}$/.test(a.phone) &&
    a.detail.trim().length >= 6
  );
}
export function confirmStory(p: Project, id: string) {
  const s = p.stories.find((s) => s.id === id);
  if (!s) throw new Error("故事不存在");
  s.confirmedVersion = s.version;
  s.included = true;
  return touch(p);
}
export const questions = [
  "小时候的家，\n是什么样子的？",
  "小时候，\n最喜欢和谁一起玩？",
  "年轻时的第一份工作，\n你还记得吗？",
  "第一次当上爸爸妈妈，\n是什么心情？",
  "有哪句话，\n想留给未来的孩子？",
];
export const samples = [
  {
    title: "老屋门前的那棵桂花树",
    chapter: "童年的小城",
    body: "我小时候住的房子，门前有一棵很大的桂花树。每到秋天，院子里都是甜甜的香味。\n\n放学回来，我总爱把书包往门边一放，搬一张小板凳坐在树下，看外婆择菜。她一边忙着手里的活，一边问我今天在学校学了什么。\n\n那时候的日子过得慢。傍晚，炊烟从屋顶升起来，街坊的招呼声从巷子那头传过来。外婆叫我吃饭，我就知道，一天又快过去了。\n\n后来我离开了家，去过很多地方。可一闻到桂花的香味，心里就又回到了那个小院子。原来有些记忆，不用特意想起，也从来没有忘记。",
  },
  {
    title: "第一次坐火车去远方",
    chapter: "青春的选择",
    body: "那是我第一次独自出远门。母亲替我收拾了一个布包，里面装着换洗的衣服，还有几块刚烙好的饼。\n\n站台上人很多，我一边紧紧攥着车票，一边回头找母亲。她站在人群里朝我挥手，嘴里说着什么，我没有听清。\n\n火车开动以后，窗外的田野一片片往后退。我忽然觉得，自己好像就在那一刻长大了。后来走过那么多路，我依然记得那一包饼的温度。",
  },
  {
    title: "成为妈妈的那一天",
    chapter: "家的模样",
    body: "第一次把孩子抱在怀里的时候，我的手都不知道该怎么放。那样小小的一个人，安安静静地靠着我。\n\n从那天起，生活多了很多琐碎的事情，也多了很多从前没有过的快乐。第一次笑，第一次叫妈妈，第一次自己走到门口，每一件小事我都记得。\n\n现在想来，最珍贵的并不是什么特别的日子，而是我们在一起，好好吃饭、慢慢长大的那些普通日子。",
  },
];
export function sampleProject(recipient: Recipient = "妈妈") {
  const p = createProject(recipient);
  p.sample = true;
  p.consent = true;
  p.buyer = "小暖";
  p.stories = samples.map((s, i) => ({
    ...s,
    title: i === 2 ? `成为${recipient}的那一天` : s.title,
    id: `sample-${i}`,
    version: 1,
    confirmedVersion: i === 2 ? null : 1,
    included: true,
    photos: [],
    recordings: [],
    sample: true,
  }));
  return p;
}
