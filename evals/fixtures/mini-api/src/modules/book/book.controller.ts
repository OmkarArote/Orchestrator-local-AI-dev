import { BookService } from './book.service';
@Controller('books')
export class BookController {
  constructor(private svc: BookService) {}
  @Post('edit')
  edit() {}
}
