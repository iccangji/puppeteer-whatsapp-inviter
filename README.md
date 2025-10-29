# Puppeteer Whatsapp Group Inviter

This project runs a Node.js container that can manage multiple worker of Puppeteer whatsapp group inviter bot.  

## Project strucutre
```
.
├── data/
│   ├── profiles/
│   │   ├── worker1/
│   │   ├── worker2/
│   │   └── ...
│   ├── inputs/
│   │   ├── worker1.xlsx
│   │   ├── worker2.xlsx
│   │   └── ...
│   ├── logs/
│   │   ├── worker1.log
│   │   ├── worker2.log
│   │   └── ...
├── src/
│   ├── index.js
│   ├── puppeteer.js
│   ├── server.js
│   └── utils/
├── .env
├── docker-compose.yml
```


## Features
- create/delete worker
- view/upload XLSX per worker
- start/stop worker
- display QR for WhatsApp login
- view per-worker logs

## Run:
1. Copy .env.example to .env and assign the value
2. Run `docker compose up -d --build `
3. Open `http://<host>:3000`

## Add new worker:
1. Click add worker on dashboard 
2. Upload xlsx file in created worker

## Change delay hours:
1. Click stop All Worker
2. Change DELAY_HOURS in .env file

## Location path
Table: `/data/inputs/worker{id}.xlsx`
Profile: `/data/profiles/worker{id}`
Logs: `/data/logs/worker{id}.log`
HTML: `/src/public/index.html`
