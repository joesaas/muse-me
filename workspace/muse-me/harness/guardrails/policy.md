# 护栏策略（结构化区块，装配时解析）
```policy
max_cost_per_run_usd: 1.00
max_cost_per_day_usd: 10.00
max_sim_amount_usd: 1000
approval_timeout_minutes: 60
risk_levels:
  read: auto
  write: batch_approval
  irreversible: single_approval
approval_default: deny
```
