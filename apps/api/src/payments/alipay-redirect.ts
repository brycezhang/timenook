import { parse, type DefaultTreeAdapterMap } from "parse5";

export type AlipayRedirectForm = {
  actionUrl: string;
  fields: Array<{
    name: string;
    value: string;
  }>;
};

export class AlipayRedirectError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "AlipayRedirectError";
  }
}

type ParsedNode = DefaultTreeAdapterMap["node"];
type ParsedElement = DefaultTreeAdapterMap["element"];

export function parseAlipayRedirectHtml(html: string): AlipayRedirectForm {
  if (html.length === 0 || html.length > 2_000_000) {
    throw new AlipayRedirectError("payment_prepare_payload_invalid");
  }

  const forms = findElements(parse(html), "form");
  if (forms.length !== 1) {
    throw new AlipayRedirectError("payment_prepare_form_invalid");
  }
  const form = forms[0]!;
  if ((attribute(form, "method") ?? "get").toLowerCase() !== "post") {
    throw new AlipayRedirectError("payment_prepare_form_method_invalid");
  }

  const actionUrl = parseAlipayActionUrl(attribute(form, "action"));
  const fields = findElements(form, "input").flatMap((input) => {
    if ((attribute(input, "type") ?? "text").toLowerCase() !== "hidden")
      return [];
    const name = attribute(input, "name");
    if (!name) return [];
    const value = attribute(input, "value") ?? "";
    if (
      name.length > 200 ||
      hasControlCharacter(name) ||
      value.length > 100_000
    ) {
      throw new AlipayRedirectError("payment_prepare_form_field_invalid");
    }
    return [{ name, value }];
  });
  if (
    fields.length === 0 ||
    fields.length > 128 ||
    fields.reduce(
      (total, field) => total + field.name.length + field.value.length,
      0,
    ) > 500_000
  ) {
    throw new AlipayRedirectError("payment_prepare_form_fields_invalid");
  }

  return { actionUrl, fields };
}

function parseAlipayActionUrl(value: string | null): string {
  if (!value || value.length > 2_048) {
    throw new AlipayRedirectError("payment_prepare_form_action_invalid");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AlipayRedirectError("payment_prepare_form_action_invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    !isAlipayHost(url.hostname)
  ) {
    throw new AlipayRedirectError("payment_prepare_form_action_invalid");
  }
  return url.toString();
}

function isAlipayHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return ["alipay.com", "alipay.cn", "alipaydev.com"].some(
    (suffix) => normalized === suffix || normalized.endsWith(`.${suffix}`),
  );
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
  });
}

function attribute(element: ParsedElement, name: string): string | null {
  return (
    element.attrs.find((candidate) => candidate.name === name)?.value ?? null
  );
}

function findElements(root: ParsedNode, tagName: string): ParsedElement[] {
  const matches: ParsedElement[] = [];
  walk(root, (node) => {
    if (isElement(node) && node.tagName === tagName) matches.push(node);
  });
  return matches;
}

function walk(node: ParsedNode, visit: (node: ParsedNode) => void): void {
  visit(node);
  if (!("childNodes" in node)) return;
  for (const child of node.childNodes) walk(child, visit);
}

function isElement(node: ParsedNode): node is ParsedElement {
  return "tagName" in node && Array.isArray(node.attrs);
}
