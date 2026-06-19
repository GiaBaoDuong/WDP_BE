# Luồng Gửi Chapter — API Mock Guide cho FE

## Tổng quan

Mangaka gửi 1 request `multipart/form-data` duy nhất → BE tự tạo:
- Chapter
- Page(s) kèm ảnh gốc (upload Cloudinary)
- Task(s) kèm region + assigned_to
- PageNote(s) kèm tọa độ + nội dung note

Assistant chỉ cần gọi **1 API** (`GET /tasks/my-assignments`) là nhận đủ ảnh + tọa độ + note.

---

## 1. Mangaka gửi Chapter cho Assistant

### API: `POST /chapters`
**Headers:** `Authorization: Bearer <token>` (Mangaka token)

**Content-Type:** `multipart/form-data`

**Body (FormData):**

| Field | Type | Required | Description |
|---|---|---|---|
| `series_id` | text | ✅ | ID của series |
| `chapter_number` | text | ✅ | Số chapter (VD: "1") |
| `title` | text | | Tiêu đề chapter |
| `pages` | file[] | ✅ | Ảnh page — mỗi file là 1 page. Gửi nhiều file để tạo nhiều page |
| `pages[<i>].note` | text | | Ghi chú cho page i (VD: "tô shading khuôn mặt") |
| `pages[<i>].work_type` | text | | `background` \| `shading` \| `effects` \| `details` \| `other` |
| `pages[<i>].assigned_to` | text | | User ID của Assistant được giao |
| `pages[<i>].x` | text | | Tọa độ X vùng làm việc (% ảnh, 0-100) |
| `pages[<i>].y` | text | | Tọa độ Y vùng làm việc (% ảnh, 0-100) |
| `pages[<i>].w` | text | | Chiều rộng vùng làm việc (% ảnh, 0-100) |
| `pages[<i>].h` | text | | Chiều cao vùng làm việc (% ảnh, 0-100) |

> `i` = index của page trong mảng files, bắt đầu từ 0. Thứ tự file = thứ tự page.

**Ví dụ (React + Axios):**

```javascript
const formData = new FormData();
formData.append("series_id", "64f1a2b3c4d5e6f7a8b9c0d1");
formData.append("chapter_number", "5");
formData.append("title", "Chương 5 - Cuộc chiến");

// Page 1
formData.append("pages", fileObjectPage1); // file input
formData.append("pages[0].note", "Tô shading khuôn mặt nhân vật chính");
formData.append("pages[0].work_type", "shading");
formData.append("pages[0].assigned_to", "64f1a2b3c4d5e6f7a8b9c0e5");
formData.append("pages[0].x", "15");
formData.append("pages[0].y", "20");
formData.append("pages[0].w", "30");
formData.append("pages[0].h", "40");

// Page 2 (không gán assistant, để trống assigned_to)
formData.append("pages", fileObjectPage2);
formData.append("pages[1].note", "Background rừng");

const res = await axios.post("/chapters", formData, {
  headers: {
    Authorization: `Bearer ${token}`,
    "Content-Type": "multipart/form-data",
  },
});
console.log(res.data.data);      // chapter
console.log(res.data.pages);     // [{_id, original_image_url, ...}]
console.log(res.data.tasks);     // [{_id, region, ...}]
```

**Response 201:**

```json
{
  "success": true,
  "data": {
    "_id": "64f1a2b3c4d5e6f7a8b9c0d2",
    "series_id": "64f1a2b3c4d5e6f7a8b9c0d1",
    "chapter_number": 5,
    "title": "Chương 5 - Cuộc chiến",
    "status": "pending_assistant"
  },
  "pages": [
    {
      "_id": "64f1a2b3c4d5e6f7a8b9c0d3",
      "page_number": 1,
      "original_image_url": "https://res.cloudinary.com/drrhyjlva/image/upload/v1781841500/wdp/chapters/.../page1.png",
      "status": "has_task"
    }
  ],
  "tasks": [
    {
      "_id": "64f1a2b3c4d5e6f7a8b9c0d4",
      "work_type": "shading",
      "region": { "x": 15, "y": 20, "width": 30, "height": 40 }
    }
  ]
}
```

---

## 2. Assistant nhận việc

### API: `GET /tasks/my-assignments`

**Headers:** `Authorization: Bearer <token>` (Assistant token)

**Query params (optional):**
| Param | Type | Description |
|---|---|---|
| `status` | string | `pending` \| `in_progress` \| `submitted` \| `approved` \| `revision` |
| `chapter_id` | string | Lọc theo chapter |
| `page` | number | Trang (default: 1) |
| `limit` | number | Items/trang (default: 20) |

**Response 200:**

```json
{
  "success": true,
  "data": [
    {
      "_id": "64f1a2b3c4d5e6f7a8b9c0d4",
      "status": "pending",
      "work_type": "shading",
      "region": {
        "x": 15,
        "y": 20,
        "width": 30,
        "height": 40
      },
      "description": "Tô shading khuôn mặt nhân vật chính",
      "note_ids": [
        {
          "_id": "64f1a2b3c4d5e6f7a8b9c0d5",
          "text": "Tô shading khuôn mặt nhân vật chính",
          "x": 15,
          "y": 20,
          "w": 30,
          "h": 40,
          "taskType": "shading"
        }
      ],
      "page_id": {
        "_id": "64f1a2b3c4d5e6f7a8b9c0d3",
        "page_number": 1,
        "original_image_url": "https://res.cloudinary.com/drrhyjlva/image/upload/v1781841500/wdp/chapters/.../page1.png"
      },
      "chapter_id": {
        "_id": "64f1a2b3c4d5e6f7a8b9c0d2",
        "chapter_number": 5,
        "title": "Chương 5 - Cuộc chiến",
        "series_id": "64f1a2b3c4d5e6f7a8b9c0d1"
      }
    }
  ],
  "pagination": {
    "total": 1,
    "page": 1,
    "limit": 20
  }
}
```

**FE hiển thị:**

```javascript
// Hiển thị ảnh gốc
const imgSrc = task.page_id.original_image_url;

// Vẽ vùng làm việc (overlay)
const { x, y, width, height } = task.region;
// x, y, width, height là % → nhân với kích thước ảnh thực tế

// Hiển thị note
task.note_ids.forEach(note => {
  console.log(`Note: ${note.text} at (${note.x}%, ${note.y}%)`);
});
```

---

## 3. Assistant xem chi tiết 1 task

### API: `GET /tasks/:id`

**Headers:** `Authorization: Bearer <token>`

**Response 200:**

```json
{
  "success": true,
  "data": {
    "_id": "64f1a2b3c4d5e6f7a8b9c0d4",
    "status": "pending",
    "work_type": "shading",
    "region": { "x": 15, "y": 20, "width": 30, "height": 40 },
    "description": "Tô shading khuôn mặt nhân vật chính",
    "note_ids": [
      {
        "_id": "64f1a2b3c4d5e6f7a8b9c0d5",
        "text": "Tô shading khuôn mặt nhân vật chính",
        "x": 15, "y": 20, "w": 30, "h": 40,
        "taskType": "shading",
        "status": "used_in_task",
        "createdAt": "2026-06-19T..."
      }
    ],
    "page_id": {
      "_id": "64f1a2b3c4d5e6f7a8b9c0d3",
      "page_number": 1,
      "original_image_url": "https://res.cloudinary.com/...",
      "result_image_url": ""
    },
    "chapter_id": {
      "_id": "...",
      "chapter_number": 5,
      "title": "Chương 5 - Cuộc chiến"
    },
    "assigned_by": {
      "username": "mangaka_hello",
      "full_name": "Mangaka Hello"
    },
    "assigned_to": {
      "username": "assistant_001",
      "full_name": "Assistant One"
    }
  }
}
```

---

## 4. Mangaka xem Chapter (với tasks + notes)

### API: `GET /chapters/:id`

**Headers:** `Authorization: Bearer <token>` (Mangaka hoặc Assistant)

**Response 200:**

```json
{
  "success": true,
  "data": {
    "_id": "64f1a2b3c4d5e6f7a8b9c0d2",
    "chapter_number": 5,
    "title": "Chương 5 - Cuộc chiến",
    "status": "pending_assistant",
    "pages": [
      {
        "_id": "64f1a2b3c4d5e6f7a8b9c0d3",
        "page_number": 1,
        "original_image_url": "https://res.cloudinary.com/...",
        "status": "has_task",
        "tasks": [
          {
            "_id": "64f1a2b3c4d5e6f7a8b9c0d4",
            "work_type": "shading",
            "region": { "x": 15, "y": 20, "width": 30, "height": 40 },
            "status": "pending",
            "assigned_to": { "username": "assistant_001" },
            "note_ids": [
              {
                "_id": "64f1a2b3c4d5e6f7a8b9c0d5",
                "text": "Tô shading khuôn mặt nhân vật chính",
                "x": 15, "y": 20, "w": 30, "h": 40
              }
            ]
          }
        ]
      }
    ]
  },
  "seriesName": "Series A"
}
```

---

## 5. Tóm tắt Mock Data cho FE

### Mock `POST /chapters` (Mangaka gửi)

```javascript
// Request (FormData)
{
  series_id: "mock_series_id",
  chapter_number: "1",
  title: "Chapter 1",
  pages: [/* File */],
  "pages[0].note": "Tô shading mặt",
  "pages[0].work_type": "shading",
  "pages[0].assigned_to": "mock_assistant_id",
  "pages[0].x": "10",
  "pages[0].y": "20",
  "pages[0].w": "30",
  "pages[0].h": "40",
}

// Mock response
{
  success: true,
  data: { _id: "mock_chapter_id", status: "pending_assistant" },
  pages: [{ _id: "mock_page_id", original_image_url: "https://...", status: "has_task" }],
  tasks: [{ _id: "mock_task_id", region: {x:10,y:20,width:30,height:40} }]
}
```

### Mock `GET /tasks/my-assignments` (Assistant nhận)

```javascript
// Mock response
{
  success: true,
  data: [{
    _id: "mock_task_id",
    status: "pending",
    work_type: "shading",
    region: { x: 10, y: 20, width: 30, height: 40 },
    description: "Tô shading mặt",
    note_ids: [{ _id: "mock_note_id", text: "Tô shading mặt", x: 10, y: 20, w: 30, h: 40, taskType: "shading" }],
    page_id: { _id: "mock_page_id", page_number: 1, original_image_url: "https://res.cloudinary.com/..." },
    chapter_id: { _id: "mock_chapter_id", chapter_number: 1, title: "Chapter 1" }
  }],
  pagination: { total: 1, page: 1, limit: 20 }
}
```

---

## 6. Luồng hoàn chỉnh

```
Mangaka                    BE                          Assistant
  │                         │                              │
  │ POST /chapters          │                              │
  │ (multipart: ảnh+note+    │                              │
  │  assigned_to+region)     │                              │
  │────────────────────────>│                              │
  │                         │ 1. Upload ảnh → Cloudinary   │
  │                         │ 2. Tạo Chapter + Page        │
  │                         │ 3. Tạo PageNote (note+coord) │
  │                         │ 4. Tạo Task (region+ref note)│
  │ 201 {chapter,pages,tasks}│                              │
  │<────────────────────────│                              │
  │                         │                              │
  │                         │                 GET /tasks/my-assignments
  │                         │            (populate: ảnh+region+note)
  │                         │<─────────────────────────────────────────│
  │                         │                 200 [{task đầy đủ}]    │
  │                         │────────────────────────────────────────>│
  │                         │                 → Hiển thị ảnh gốc   │
  │                         │                 → Vẽ region overlay  │
  │                         │                 → Đọc note.text     │
```
