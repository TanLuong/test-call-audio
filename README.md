# Sharegram Call

Trang web test cuộc gọi video/audio 1-1 sử dụng **SRS (Simple Realtime Server)** + WebRTC.

## Kiến trúc

```
Browser ──HTTPS──▶ Cloudflare ──HTTP──▶ Nginx (port 80)
                                          ├─ /           → static web files
                                          ├─ /rtc/v1/    → SRS:1985 (WHIP/WHEP)
                                          └─ /socket.io/ → Signaling:3000

WebRTC UDP Media: Browser ──UDP──▶ Server IP:8000 (TRỰC TIẾP, bypass Cloudflare)
```

## Yêu cầu

- Docker & Docker Compose
- Domain + Cloudflare (SSL termination)
- Firewall mở: **port 80 (TCP)**, **port 8000 (UDP)**

> ⚠️ **Quan trọng**: Port 8000/UDP phải được mở trực tiếp, KHÔNG qua Cloudflare proxy. Dùng DNS-only (gray cloud) cho subdomain nếu cần.

## Cài đặt

### 1. Clone và tạo file `.env`

```bash
cp .env.example .env
nano .env
```

Điền vào:
```env
CANDIDATE=<IP_PUBLIC_CỦA_SERVER>   # Lấy từ cloud provider
DOMAIN=yourdomain.com
```

Lấy IP public của server:
```bash
curl ifconfig.me
```

### 2. Cấu hình Cloudflare

- **Proxy mode**: Bật Cloudflare proxy (orange cloud) cho domain chính → HTTPS cho web và signaling
- **Port 8000**: Cloudflare KHÔNG proxy UDP → SRS WebRTC media sẽ kết nối thẳng đến IP server

### 3. Chạy

```bash
docker compose up -d
```

Kiểm tra:
```bash
docker compose logs -f
```

### 4. Truy cập

Mở trình duyệt: `https://yourdomain.com`

## Luồng gọi

1. **User A** mở trang → "Tạo phòng" → nhận **mã phòng** (vd: `ABC123`)
2. **User A** chia sẻ mã phòng cho **User B**
3. **User B** mở trang → "Tham gia" → nhập mã phòng
4. Cả 2 user vào `call.html` → camera/mic được bật
5. SRS nhận stream từ cả 2 qua **WHIP**
6. Cả 2 subscribe stream của nhau qua **WHEP**
7. Cuộc gọi được thiết lập! 🎉

## Cấu trúc thư mục

```
Sharegram-call/
├── docker-compose.yml     # Orchestration: SRS + Signaling + Nginx
├── .env.example           # Template biến môi trường
├── nginx/
│   └── nginx.conf         # Reverse proxy
├── signaling/
│   ├── Dockerfile
│   ├── package.json
│   └── server.js          # Socket.IO room management
└── web/
    ├── index.html          # Lobby (tạo/join phòng)
    ├── call.html           # Giao diện cuộc gọi
    ├── style.css           # Dark glassmorphism UI
    └── app.js              # WebRTC WHIP/WHEP client
```

## Troubleshooting

| Lỗi | Nguyên nhân | Giải pháp |
|-----|-------------|-----------|
| Camera/mic bị chặn | HTTPS bắt buộc | Đảm bảo truy cập qua HTTPS (Cloudflare) |
| WHIP/WHEP thất bại | `CANDIDATE` sai | Kiểm tra IP server trong `.env` |
| Không nhận được video | Port 8000/UDP bị chặn | Mở port 8000/UDP trên firewall |
| Socket.IO không kết nối | Nginx config | Kiểm tra log nginx và signaling |
