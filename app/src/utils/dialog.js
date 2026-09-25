import { Alert, Platform } from 'react-native';

/**
 * 跨平台对话框工具。
 *
 * 背景：react-native-web 的 Alert 是空实现（`static alert() {}`）——
 * 在 Web 端既不弹窗、也不会触发按钮回调。本项目同时以 Web 站点形式部署，
 * 因此凡是需要「确认后执行」或「必须让用户看到」的提示，都走这里：
 *   - Web：window.confirm / window.alert / 自绘 DOM 浮层
 *   - 原生：Alert.alert（带按钮）
 *
 * 注意：不要在各页面里直接用 Alert.alert，否则 Web 端会静默无反应。
 */

const isWeb = Platform.OS === 'web';

/**
 * 确认对话框。用户确认后执行 onConfirm。
 * @param {object} opts
 * @param {string} opts.title 标题
 * @param {string} [opts.message] 正文
 * @param {string} [opts.confirmText] 确认按钮文案
 * @param {string} [opts.cancelText] 取消按钮文案
 * @param {boolean} [opts.destructive] 是否危险操作（原生端标红）
 * @param {Function} opts.onConfirm 确认回调
 */
export function confirmDialog({
  title,
  message = '',
  confirmText = '确定',
  cancelText = '取消',
  destructive = false,
  onConfirm,
}) {
  if (isWeb && typeof window !== 'undefined' && typeof window.confirm === 'function') {
    const text = message ? `${title}\n\n${message}` : title;
    if (window.confirm(text)) {
      if (onConfirm) onConfirm();
    }
    return;
  }

  Alert.alert(title, message, [
    { text: cancelText, style: 'cancel' },
    {
      text: confirmText,
      style: destructive ? 'destructive' : 'default',
      onPress: onConfirm,
    },
  ]);
}

/**
 * 单纯提示（无选择），确保 Web 端也能看到。
 */
export function notify(title, message = '') {
  if (isWeb && typeof window !== 'undefined' && typeof window.alert === 'function') {
    window.alert(message ? `${title}\n\n${message}` : title);
    return;
  }
  Alert.alert(title, message);
}

/**
 * 多选一对话框（选项多于两个时用）。
 * Web 端用自绘 DOM 浮层（window.confirm 表达不了三个选项），原生端用 Alert 按钮数组。
 *
 * @param {object} opts
 * @param {string} opts.title 标题
 * @param {string} [opts.message] 正文
 * @param {Array<{text: string, style?: string, onPress?: Function}>} opts.options 选项（按顺序展示）
 * @param {string} [opts.cancelText] 取消按钮文案
 */
export function chooseDialog({ title, message = '', options = [], cancelText = '取消' }) {
  if (isWeb && typeof document !== 'undefined') {
    showWebChooser(title, message, options, cancelText);
    return;
  }

  Alert.alert(title, message, [
    ...options.map((o) => ({ text: o.text, style: o.style, onPress: o.onPress })),
    { text: cancelText, style: 'cancel' },
  ]);
}

/** Web 端的浮层实现：全部内联样式，不依赖任何 CSS 文件 */
function showWebChooser(title, message, options, cancelText) {
  const overlay = document.createElement('div');
  overlay.setAttribute('role', 'dialog');
  overlay.style.cssText =
    'position:fixed;inset:0;background:rgba(15,23,42,.45);display:flex;align-items:center;' +
    'justify-content:center;z-index:99999;padding:20px;';

  const card = document.createElement('div');
  card.style.cssText =
    'background:#fff;border-radius:14px;max-width:380px;width:100%;padding:22px;' +
    'box-shadow:0 20px 45px rgba(15,23,42,.25);';

  const close = () => {
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
  };

  const heading = document.createElement('div');
  heading.textContent = title;
  heading.style.cssText = 'font-size:17px;font-weight:700;color:#1e293b;margin-bottom:8px;';
  card.appendChild(heading);

  if (message) {
    const body = document.createElement('div');
    body.textContent = message;
    body.style.cssText = 'font-size:14px;color:#475569;line-height:1.6;margin-bottom:16px;';
    card.appendChild(body);
  }

  const row = document.createElement('div');
  row.style.cssText = 'display:flex;flex-direction:column;gap:10px;';

  const makeButton = (text, primary, onClick) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = text;
    btn.style.cssText = primary
      ? 'padding:12px;border-radius:10px;font-size:15px;font-weight:600;cursor:pointer;' +
        'border:1px solid #2563eb;background:#2563eb;color:#fff;font-family:inherit;'
      : 'padding:12px;border-radius:10px;font-size:15px;font-weight:600;cursor:pointer;' +
        'border:1px solid #e2e8f0;background:#fff;color:#475569;font-family:inherit;';
    btn.onclick = () => {
      close();
      if (onClick) onClick();
    };
    return btn;
  };

  options.forEach((opt) => {
    row.appendChild(makeButton(opt.text, opt.style !== 'cancel', opt.onPress));
  });
  row.appendChild(makeButton(cancelText, false, null));

  card.appendChild(row);
  overlay.appendChild(card);
  // 点遮罩关闭，等同于取消
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  document.body.appendChild(overlay);
}
