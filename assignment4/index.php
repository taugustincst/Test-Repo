<?php 
	// require('include/connection.php');
	include('class_lib.php');
?>

<!DOCTYPE html>
<html lang="en">
	<head>
		<title>Assignment 4 - OOP</title>
		<!-- template uses jQuery, jQuery UI + theme, + bootsrap + connection to mySQL database (deine name of database to connect) -->
		<meta charset="utf-8">
			<meta name="viewport" content="width=device-width, initial-scale=1.0">
			<link rel="stylesheet" type="text/css" href="stylesheet.css">
			<link rel="stylesheet" type="text/css" href="bootstrap/css/bootstrap.min.css">
			<link rel="stylesheet" href="http://code.jquery.com/ui/1.10.3/themes/smoothness/jquery-ui.css" />
			<script src="http://ajax.googleapis.com/ajax/libs/jquery/1.10.2/jquery.min.js"></script>
			<script src="http://ajax.googleapis.com/ajax/libs/jqueryui/1.10.3/jquery-ui.min.js"></script>
			<script type="text/javascript">



			</script>
	</head>
	<body>	
		<div id="container">
			<div id="header">


			</div>
			<div id="content">
<?php 

	$animal = new Animal('Fred');
	$animal->walk();
	$animal->walk();
	$animal->walk();
	$animal->run();
	$animal->run();
	$animal->displayHealth();

	$dog = new Dog('Moose');
	$dog->walk();
	$dog->walk();
	$dog->walk();
	$dog->run();
	$dog->run();
	$dog->pet();
	$dog->displayHealth();

	$dragon = new Dragon('Puff');
	$dragon->displayHealth();
	$dragon->fly();
	$dragon->displayHealth();

?>


			</div>
			<div id="footer">


			</div>


		</div>



	</body>	
</html>