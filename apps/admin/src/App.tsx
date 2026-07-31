const modules = [
  ["认证审核", "M2 开放"],
  ["路线配置", "M3 开放"],
  ["组队检索", "M3 开放"],
  ["订单退款", "M4 开放"],
  ["举报风控", "M5 开放"],
  ["审计日志", "M2 开放"],
] as const;

export function App() {
  return (
    <main className="shell">
      <header>
        <p className="eyebrow">Campus Companion · M1</p>
        <h1>校园同行运营后台</h1>
        <p className="summary">
          当前仅为工程基础壳。管理员登录、审核和敏感操作将在对应里程碑实现并验证。
        </p>
      </header>
      <section aria-labelledby="module-title">
        <h2 id="module-title">模块边界</h2>
        <div className="grid">
          {modules.map(([name, state]) => (
            <article key={name}>
              <h3>{name}</h3>
              <span>{state}</span>
            </article>
          ))}
        </div>
      </section>
      <aside role="note">后台不会提供司机、车辆、运价、车费或运输状态功能。</aside>
    </main>
  );
}
