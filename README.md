# Puppeteer Whatsapp Group Inviter

This project runs a Node.js container that can manage multiple worker of Puppeteer whatsapp group inviter bot.  

## Project strucutre
```
.
├── docker-compose.yml
├── src/
│   ├── index.js
│   ├── puppeteer.js
│   ├── server.js
│   └── utils/
├── data/
│   ├── profiles/
│   │   ├── worker1/
│   │   ├── worker2/
│   │   └── ...
│   ├── inputs/
│   │   ├── worker1.csv
│   │   ├── worker2.csv
│   │   └── ...
├── add-worker.sh
└── README.md
```


## Features
- create/delete worker
- upload CSV per worker
- start/stop worker
- display QR for WhatsApp login
- view per-worker logs

## Run:
1. Copy .env.example to .env and assign the value
2. Run `docker compose up -d --build `
3. Open `http://<host>:3000`

## Add new worker:
1. Click add worker on dashboard 
2. Upload csv file in created worker

## Change delay hours:
1. Click stop All Worker
2. Change DELAY_HOURS in .env file

## Location path
CSV file: `/data/inputs/worker{id}.csv`
Profile: `/data/profiles/worker{id}`
Logs: `/data/logs/worker{id}.log`
HTML: `/src/public/index.html`
