function editableText(initialValue, className, placeholder) {
  const element = document.createElement("div");
  element.className = className;
  element.contentEditable = "true";
  element.spellcheck = true;
  element.dataset.placeholder = placeholder;
  element.innerHTML = initialValue || "";
  return element;
}

export class TodoTool {
  static get toolbox() {
    return { title: "Checklist" };
  }

  constructor({ data = {} }) {
    this.data = {
      text: data.text || "",
      checked: Boolean(data.checked),
    };
    this.checkbox = null;
    this.textInput = null;
  }

  render() {
    const wrapper = document.createElement("div");
    wrapper.className = "editor-todo";

    this.checkbox = document.createElement("input");
    this.checkbox.type = "checkbox";
    this.checkbox.className = "editor-todo-checkbox";
    this.checkbox.checked = this.data.checked;

    this.textInput = editableText(this.data.text, "editor-todo-text", "Item da checklist");
    wrapper.append(this.checkbox, this.textInput);
    return wrapper;
  }

  save() {
    return {
      text: this.textInput?.innerHTML || "",
      checked: Boolean(this.checkbox?.checked),
    };
  }
}

export class QuoteTool {
  static get toolbox() {
    return { title: "Citação" };
  }

  constructor({ data = {} }) {
    this.data = {
      text: data.text || "",
      caption: data.caption || "",
    };
    this.textInput = null;
    this.captionInput = null;
  }

  render() {
    const wrapper = document.createElement("div");
    wrapper.className = "editor-quote";

    this.textInput = editableText(this.data.text, "editor-quote-text", "Escreva a citação");
    this.captionInput = editableText(this.data.caption, "editor-quote-caption", "Fonte ou contexto");

    wrapper.append(this.textInput, this.captionInput);
    return wrapper;
  }

  save() {
    return {
      text: this.textInput?.innerHTML || "",
      caption: this.captionInput?.innerHTML || "",
    };
  }
}

export class CodeBlockTool {
  static get toolbox() {
    return { title: "Código" };
  }

  constructor({ data = {} }) {
    this.data = {
      code: data.code || "",
    };
    this.textarea = null;
  }

  render() {
    const wrapper = document.createElement("div");
    wrapper.className = "editor-code";

    this.textarea = document.createElement("textarea");
    this.textarea.className = "editor-code-textarea";
    this.textarea.placeholder = "Cole ou escreva código";
    this.textarea.value = this.data.code;
    wrapper.appendChild(this.textarea);
    return wrapper;
  }

  save() {
    return {
      code: this.textarea?.value || "",
    };
  }
}

export class DividerTool {
  static get toolbox() {
    return { title: "Divisor" };
  }

  render() {
    const wrapper = document.createElement("div");
    wrapper.className = "editor-divider";
    const hr = document.createElement("hr");
    wrapper.appendChild(hr);
    return wrapper;
  }

  save() {
    return {};
  }
}
