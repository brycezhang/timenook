export interface Story {
  id: string;
  title: string;
  chapter: string;
  date: string;
  minutes: number;
  included: boolean;
  paragraphs: string[];
  photo?: string;
}
export interface Project {
  id: string;
  title: string;
  subject: string;
  subtitle: string;
  stories: Story[];
}
export const initialProjects: Project[] = [
  {
    id: "mother",
    title: "妈妈的一生",
    subject: "妈妈",
    subtitle: "那些平凡日子里，闪着光的时刻。",
    stories: [
      {
        id: "s1",
        title: "外婆家门前的那棵桂花树",
        chapter: "童年时光",
        date: "11月6日",
        minutes: 8,
        included: true,
        paragraphs: [
          "我小时候，外婆家的门前有一棵很大的桂花树。每到秋天，还没走到巷子口，就先闻到了那股甜甜的香。",
          "那时候日子慢。放学回来，把书包往板凳上一扔，我就跑到树底下找外婆。她总坐在那儿择菜，脚边放着一只旧竹篮。看到我，她就笑着从口袋里摸出一颗糖。",
          "后来我去了很远的地方，也见过许多桂花树。但记忆里最香的，始终是外婆门前的那一棵。",
        ],
      },
      {
        id: "s2",
        title: "第一次离开家，去远方读书",
        chapter: "青春岁月",
        date: "11月5日",
        minutes: 12,
        included: true,
        paragraphs: [
          "十九岁那年，我第一次坐上绿皮火车，去省城读书。妈妈给我缝了一个布袋子，把路上吃的东西放得满满当当。",
          "站台上的汽笛响起来，我才突然觉得，自己是真的要离开家了。窗外的人越来越小，故乡的山也慢慢退到了身后。",
          "可我心里也藏着一点兴奋。那时不知道远方是什么样子，只觉得，属于自己的生活就要开始了。",
        ],
      },
      {
        id: "s3",
        title: "有了你以后，日子有了新的模样",
        chapter: "成家立业",
        date: "11月3日",
        minutes: 6,
        included: true,
        photo: "assets/family.jpg",
        paragraphs: [
          "你出生的那一天，天刚蒙蒙亮。我抱着小小的你，觉得世界一下子变得很安静。",
          "后来那些忙忙碌碌的日子，现在想起来，都成了最舍不得的片段。第一声妈妈，第一次走路，还有你攥着我的手，不肯去幼儿园的早晨。",
        ],
      },
      {
        id: "s4",
        title: "那年夏天，一家人的小旅行",
        chapter: "生活点滴",
        date: "11月2日",
        minutes: 9,
        included: false,
        paragraphs: [
          "那年暑假，我们一家人坐了很久的车去看海。你一见到海水，就把鞋子甩在沙滩上，直直地跑了过去。",
          "晚上海风吹着，我们坐在小店门口，吃了一顿再普通不过的晚饭。可到今天，那顿饭的味道我都还记得。",
        ],
      },
    ],
  },
  {
    id: "father",
    title: "爸爸的时光手记",
    subject: "爸爸",
    subtitle: "慢慢听，也慢慢记。",
    stories: [],
  },
];
export const chapters = ["童年时光", "青春岁月", "成家立业", "生活点滴"];
export const topics = [
  {
    chapter: "童年时光",
    question: "小时候，有没有一个让你特别怀念的地方？",
    hint: "可以从一条巷子、一座老房子，或一个熟悉的味道说起。",
  },
  {
    chapter: "青春岁月",
    question: "还记得第一次离开家时的心情吗？",
    hint: "那一年，你去了哪里？又是谁送你出发的？",
  },
  {
    chapter: "成家立业",
    question: "哪一个瞬间，让你觉得自己有了一个家？",
    hint: "不必是大事，一顿饭、一句话，都可以是故事的开始。",
  },
  {
    chapter: "生活点滴",
    question: "这些年，有什么小事一想起来就会笑？",
    hint: "和家人在一起的时刻，也值得好好收藏。",
  },
];
