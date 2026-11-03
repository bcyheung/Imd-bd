-- 申請材料對應申請類型清單裡的哪一項；舊資料與證件掃描件為 NULL。
ALTER TABLE attachments ADD COLUMN requirement TEXT;
