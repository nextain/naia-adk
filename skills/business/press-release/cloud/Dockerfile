FROM node:22-alpine
WORKDIR /app
COPY package.json .
RUN npm install --production
COPY send.js contacts.json template.html subject.txt ./
ENTRYPOINT ["node", "send.js"]
CMD ["send", "--delay", "30"]
