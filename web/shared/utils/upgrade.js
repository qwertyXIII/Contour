// Оживить блоки на странице — и те, что появятся потом: слайды просмотра,
// ответ сервера, экран, собранный из объявлений. Компоненты по-прежнему
// создаются только из index.js — он передаёт сюда свой список.
//
// Каждый элемент оживает один раз: перенос узла в другое место (перетащили
// виджет, просмотр переложил слайд) — это новое «добавление» для наблюдателя,
// но не новый компонент. Один элемент может быть корнем нескольких
// компонентов (блок и data-reveal на нём же) — учёт у каждого свой.
export function upgrade(root, components) {
  const alive = new Map(components.map(([, Component]) => [Component, new WeakSet()]));

  const bring = (el, Component) => {
    const seen = alive.get(Component);
    if (seen.has(el)) return;
    seen.add(el);
    new Component(el).init();
  };

  const scan = (node) => {
    components.forEach(([selector, Component]) => {
      if (node.matches(selector)) bring(node, Component);
      node.querySelectorAll(selector).forEach((el) => bring(el, Component));
    });
  };

  scan(root);
  new MutationObserver((records) => {
    records.forEach((record) => record.addedNodes.forEach((node) => {
      if (node.nodeType === Node.ELEMENT_NODE && node.isConnected) scan(node);
    }));
  }).observe(root, { childList: true, subtree: true });
}
