const { createBoardServer } = require('./server-app');

const { server } = createBoardServer();
const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`Online-доска запущена: http://localhost:${PORT}`);
});
