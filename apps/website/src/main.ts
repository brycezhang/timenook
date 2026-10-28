import { samples } from "../../../miniprogram/domain/model";

function element<T extends HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`Missing website element: ${selector}`);
  return found;
}

function paragraphs(target: HTMLElement, text: string) {
  target.replaceChildren(
    ...text.split("\n\n").map((content) => {
      const paragraph = document.createElement("p");
      paragraph.textContent = content;
      return paragraph;
    }),
  );
}

let storyIndex = 0;
const previous = element<HTMLButtonElement>("#previous-story");
const next = element<HTMLButtonElement>("#next-story");
function renderStory() {
  const story = samples[storyIndex];
  element("#book-chapter").textContent = story.chapter;
  element("#book-title").textContent = story.title;
  element("#book-quote").textContent = `“${story.body.split("。")[0]}。”`;
  paragraphs(element("#book-story"), story.body);
  element("#book-position").textContent =
    `${storyIndex + 1} / ${samples.length}`;
  element("#book-folio").textContent = String(storyIndex + 1).padStart(2, "0");
  previous.disabled = storyIndex === 0;
  next.disabled = storyIndex === samples.length - 1;
}
previous.addEventListener("click", () => {
  storyIndex--;
  renderStory();
});
next.addEventListener("click", () => {
  storyIndex++;
  renderStory();
});
renderStory();

const narration = element<HTMLButtonElement>("#narration-tab");
const editedStory = element<HTMLButtonElement>("#story-tab");
const panel = element("#demo-panel");
const narrationText = panel.textContent?.trim() ?? "";
const tabs = [narration, editedStory];
function selectTab(index: number, focus = false) {
  tabs.forEach((tab, position) => {
    tab.setAttribute("aria-selected", String(position === index));
    tab.tabIndex = position === index ? 0 : -1;
  });
  panel.setAttribute("aria-labelledby", tabs[index].id);
  paragraphs(panel, index === 0 ? narrationText : samples[0].body);
  if (focus) tabs[index].focus();
}
tabs.forEach((tab, index) => {
  tab.addEventListener("click", () => selectTab(index));
  tab.addEventListener("keydown", (event) => {
    const destinations: Record<string, number> = {
      ArrowLeft: 1 - index,
      ArrowRight: 1 - index,
      Home: 0,
      End: 1,
    };
    const target = destinations[event.key];
    if (target !== undefined) {
      event.preventDefault();
      selectTab(target, true);
    }
  });
});

const orderDialog = element<HTMLDialogElement>("#order-dialog");
let orderOpener: HTMLElement | null = null;
for (const button of document.querySelectorAll<HTMLButtonElement>(
  "[data-order]",
)) {
  button.addEventListener("click", () => {
    orderOpener = button;
    orderDialog.showModal();
  });
}
element(".dialog-close").addEventListener("click", () => orderDialog.close());
element("#dialog-done").addEventListener("click", () => orderDialog.close());
orderDialog.addEventListener("close", () => orderOpener?.focus());
